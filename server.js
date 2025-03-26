require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bodyParser = require('body-parser');
const server = express();
const SECRET_KEY = process.env.SECRET_KEY;
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 3001;

//const serviceAccount = require('./config/firebase-key.json');
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_KEY, 'base64').toString('utf8'));

/*
    $fileContent = Get-Content -Path "config/firebase-key.json" -Raw
    $base64String = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($fileContent))
    Write-Output $base64String
 */

if (!admin.apps.length){
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
} else {
    admin.app();
}

const routes = require('./routes');

server.use(
    cors({
        origin: ["http://localhost:3000", "https://server1-gb00.onrender.com/"],
        credentials: true,
    })
);

server.use(bodyParser.json());
const db = admin.firestore();

//Midellware para conocer lo que pasa por el codigo
server.use((req, res, next) => {
    console.log(`📡[${req.method}] ${req.url} = Body:`, req.body);
    const startTime = Date.now();

    const originalSend = res.send;
    let statusCode;

    res.send = function (body) {
        statusCode = res.statusCode;
        originalSend.call(this, body);
    };

    res.on('finish', async () => {
        const logLevel = res.statusCode >= 400 ? 'error' : 'info';
        const responseTime = Date.now() - startTime;
        const logData = {
            server: "Server2",
            alumno: {
                nombre: "Sergio",
                appellidop: "Pérez",
                appellidom: "Aldavalde",
                grupo: "IDGS011"
            },
            usuario: req.user ? req.user.email : "No autenticado",
            logLevel: logLevel,
            timestamp: new Date(),
            method: req.method,
            url: req.url,
            path: req.path,
            query: req.query,
            params: req.params,
            status: statusCode || res.statusCode,
            responseTime: responseTime,
            userAgent: req.get('User-Agent'),
            protocol: req.protocol,
            hostname: req.hostname,
            system: {
                nodeVersion: process.version,
                environment: process.env.NODE_ENV || 'development',
                pid: process.pid
            },
        };

        // Guardar logData en Firestore con una ID auto generada
        try {
            /*const logRef = */
            await db.collection('INFOLOGS').add(logData); // Firestore genera la ID automáticamente
            //console.log('Log guardado en Firestore con ID:', logRef.id); // Opcional: Mostrar la ID generada
        } catch (error) {
            console.error('Error al guardar en Firestore:', error);
        }
    });
    next();
});

server.use("/api", routes);

server.get('/', async (req,res) => {
    res.send("Conexión exitosa")
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});