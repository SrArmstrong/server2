const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");

const SECRET_KEY = process.env.SECRET_KEY;
const db = admin.firestore();

router.post("/register", async (req, res) => {
    try {
        let { email, username, password } = req.body;

        if (!password || !username || !email) {
            return res.status(400).json({ message: "Faltan datos obligatorios" });
        }

        // Convertir email a minúsculas para evitar duplicados
        const emailLower = email.toLowerCase();

        // Validación del formato de email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(emailLower)) {
            return res.status(400).json({ error: "Correo electrónico no válido" });
        }

        const userRef = db.collection("USUARIOS").doc(emailLower);
        const doc = await userRef.get();

        if (doc.exists) {
            return res.status(400).json({ message: "El usuario ya está registrado" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const secret = speakeasy.generateSecret({ length: 20 });

        // Crear la URL para Google Authenticator
        const otpAuthUrl = `otpauth://totp/MyApp:${emailLower}?secret=${secret.base32}&issuer=MyApp`;

        // Generar código QR
        const qrCodeUrl = await qrcode.toDataURL(otpAuthUrl);

        // Guardar en Firestore
        await userRef.set({
            username,
            email: emailLower,
            password: hashedPassword,
            qr: qrCodeUrl,
            mfaSecret: secret.base32 // Guardamos el secreto en Base32
        });

        res.json({ 
            message: "Usuario registrado con éxito",
            qrCodeUrl, // QR en formato base64
            secret: secret.otpauth_url // Enviar solo la URL del código QR para MFA
        });

    } catch (error) {
        console.error("Error en el registro:", error);
        res.status(500).json({ message: "Error interno del servidor" });
    }
});



router.post("/login", async (req, res) => {
    try {
        const { email, password, token } = req.body;

        if (!email || !password || !token) {
            return res.status(400).json({ message: "Faltan datos obligatorios" });
        }

        const emailLower = email.toLowerCase();
        const userRef = db.collection("USUARIOS").doc(emailLower);
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(401).json({ message: "Credenciales incorrectas" });
        }

        const user = doc.data();
        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({ message: "Credenciales incorrectas" });
        }

        // Verificar MFA
        const isValidToken = speakeasy.totp.verify({
            secret: user.mfaSecret,
            encoding: "base32",
            token: token,
            window: 1 // Permite que el código sea válido por un corto margen de error
        });

        if (!isValidToken) {
            return res.status(401).json({ message: "Código MFA incorrecto" });
        }

        // Generar Token JWT
        if (!process.env.SECRET_KEY) {
            return res.status(500).json({ message: "Error en el servidor, falta clave secreta" });
        }

        const jwtToken = jwt.sign({ email: emailLower }, process.env.SECRET_KEY, { expiresIn: "2h" });

        res.json({ message: "Inicio de sesión exitoso", token: jwtToken });

    } catch (error) {
        console.error("Error en el login:", error);
        res.status(500).json({ message: "Error interno del servidor" });
    }
});


const verifyToken = (req, res, next) => {
    const token = req.headers["authorization"];
    if (!token) return res.status(403).json({ message: "Token requerido"});

    jwt.verify(token.split(" ")[1], SECRET_KEY, (err, decoded) => {
        if (err)
            return res.status(401).json({ message: "Token invalido o expirado"});
        req.user = decoded;
        next();
    });
};

router.post("/verify-token", (req, res) => {
    const token = req.headers["authorization"];

    if (!token) {
        return res.status(403).json({ valid: false, message: "Token requerido" });
    }

    const tokenParts = token.split(" ");
    if (tokenParts.length !== 2 || tokenParts[0] !== "Bearer") {
        return res.status(400).json({ valid: false, message: "Formato de token inválido" });
    }

    const jwtToken = tokenParts[1];

    jwt.verify(jwtToken, SECRET_KEY, (err, decoded) => {
        if (err) {
            return res.status(401).json({ valid: false, message: "Token inválido o expirado" });
        }

        res.json({ valid: true, message: "Token válido", user: decoded });
    });
});


router.get("/getinfo", /*verifyToken*/ async (req, res) => {
    try {
        const userRef = db.collection("INFOLOGS").orderBy("timestamp", "desc"); // Ordenar por timestamp descendente
        const snapshot = await userRef.get();

        if (snapshot.empty) {
            return res.status(404).json({
                success: false,
                message: "No hay logs disponibles",
                data: { total_logs: 0, logs: [] }
            });
        }

        const logs = snapshot.docs.map(doc => ({
            id: doc.id,  // Se incluye el ID del documento
            ...doc.data()
        }));

        return res.json({
            success: true,
            message: "Datos recuperados correctamente",
            data: {
                total_logs: logs.length,
                logs
            }
        });

    } catch (error) {
        console.error("Error al obtener logs:", error);
        return res.status(500).json({
            success: false,
            message: "Error interno del servidor",
            error: error.message
        });
    }
});

// Nuevo endpoint para estadísticas por servidor
router.get("/server-stats", /*verifyToken,*/ async (req, res) => {
    try {
        const snapshot = await db.collection("INFOLOGS").get();
        
        if (snapshot.empty) {
            return res.status(404).json({
                success: false,
                message: "No hay logs disponibles"
            });
        }

        const logs = snapshot.docs.map(doc => doc.data());
        
        // Procesamiento por servidor
        const serverStats = {
            Server1: getStatsForServer(logs, "Server1"),
            Server2: getStatsForServer(logs, "Server2")
        };

        res.json({
            success: true,
            data: serverStats
        });

    } catch (error) {
        console.error("Error en /server-stats:", error);
        res.status(500).json({
            success: false,
            message: "Error al procesar estadísticas por servidor"
        });
    }
});

// Función auxiliar para procesar logs de un servidor específico
function getStatsForServer(logs, serverName) {
    const serverLogs = logs.filter(log => log.server === serverName);
    
    return {
        totalRequests: serverLogs.length,
        methods: countByField(serverLogs, "method"),
        statusCodes: countByField(serverLogs, "status"),
        topEndpoints: getTopEndpoints(serverLogs, 5),
        userDistribution: countByField(
            serverLogs.map(log => log.alumno ? `${log.alumno.nombre} ${log.alumno.appellidop}` : "Anónimo"),
            ""
        )
    };
}

function countByField(items, field) {
    return items.reduce((acc, item) => {
        const key = field ? item[field] : item;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
}

function getTopEndpoints(logs, limit) {
    const endpoints = logs.reduce((acc, log) => {
        acc[log.url] = (acc[log.url] || 0) + 1;
        return acc;
    }, {});

    return Object.entries(endpoints)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([url, count]) => ({ url, count }));
}

router.get("/random", (req, res) => {
    const random = Math.floor(Math.random() * 100) + 1;
    res.send(`El núemero es: ${random}`);
    console.log(`EL número random es: ${random}`);
});

module.exports = router;