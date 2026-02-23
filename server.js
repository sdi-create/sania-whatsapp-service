const crypto = require('crypto');
global.crypto = crypto;
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'warn' });

let serviceState = {
    status: 'initializing',
    qrCode: null,
    qrCodeDataUrl: null,
    pairingCode: null,
    connectedNumber: null,
    connectedName: null,
    lastActivity: null,
    messagesSent: 0,
    messagesReceived: 0,
    version: '2.4-baileys-render'
};

let messageHistory = [];
const MAX_HISTORY = 100;
let sock = null;
let connectionAttempts = 0;

const AUTH_PATH = path.join(__dirname, '.baileys_auth');

async function startConnection() {
    try {
        if (!fs.existsSync(AUTH_PATH)) {
            fs.mkdirSync(AUTH_PATH, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        const { version } = await fetchLatestBaileysVersion();
        
        console.log('Creating WhatsApp connection...');
        serviceState.status = 'connecting';

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: ['Ubuntu', 'Chrome', '114.0.0'],
            generateHighQualityLinkPreview: false,
            getMessage: async () => undefined
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR Code received!');
                serviceState.status = 'qr_ready';
                serviceState.qrCode = qr;
                connectionAttempts = 0;
                try {
                    serviceState.qrCodeDataUrl = await QRCode.toDataURL(qr, { 
                        errorCorrectionLevel: 'M',
                        width: 256,
                        margin: 2 
                    });
                    console.log('QR Code ready for scanning');
                } catch (err) {
                    console.error('QR encode error:', err.message);
                }
            }

            if (connection === 'connecting') {
                console.log('Connecting to WhatsApp...');
                serviceState.status = 'connecting';
            }

            if (connection === 'open') {
                console.log('Connected to WhatsApp!');
                connectionAttempts = 0;
                serviceState.status = 'ready';
                serviceState.qrCode = null;
                serviceState.qrCodeDataUrl = null;
                serviceState.pairingCode = null;
                serviceState.lastActivity = new Date().toISOString();
                
                if (sock.user) {
                    serviceState.connectedNumber = sock.user.id.split(':')[0].split('@')[0];
                    serviceState.connectedName = sock.user.name || sock.user.verifiedName || 'User';
                    console.log('Logged in as: ' + serviceState.connectedName);
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output?.statusCode 
                    : null;
                
                console.log('Connection closed: ' + (DisconnectReason[statusCode] || statusCode || 'unknown'));

                serviceState.qrCode = null;
                serviceState.qrCodeDataUrl = null;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('Logged out - clearing session');
                    serviceState.status = 'logged_out';
                    serviceState.connectedNumber = null;
                    serviceState.connectedName = null;
                    if (fs.existsSync(AUTH_PATH)) {
                        fs.rmSync(AUTH_PATH, { recursive: true, force: true });
                    }
                    connectionAttempts = 0;
                }
                
                if (shouldReconnect && connectionAttempts < 10) {
                    connectionAttempts++;
                    const delay = Math.min(connectionAttempts * 2000, 20000);
                    console.log('Reconnecting in ' + (delay/1000) + 's...');
                    serviceState.status = 'reconnecting';
                    setTimeout(startConnection, delay);
                } else if (connectionAttempts >= 10) {
                    console.log('Too many attempts - waiting for manual action');
                    serviceState.status = 'disconnected';
                    connectionAttempts = 0;
                }
            }
        });

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe || !msg.message) continue;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '[media]';
                const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown';
                
                serviceState.messagesReceived++;
                serviceState.lastActivity = new Date().toISOString();
                
                messageHistory.unshift({
                    id: msg.key.id,
                    from,
                    text,
                    timestamp: new Date().toISOString()
                });
                if (messageHistory.length > MAX_HISTORY) messageHistory.pop();
            }
        });

    } catch (err) {
        console.error('Connection error:', err.message);
        serviceState.status = 'error';
        connectionAttempts++;
        if (connectionAttempts < 10) {
            setTimeout(startConnection, 5000);
        }
    }
}

app.get('/status', (req, res) => res.json(serviceState));

app.get('/qr', (req, res) => {
    if (serviceState.qrCodeDataUrl) {
        res.json({ success: true, qrCodeDataUrl: serviceState.qrCodeDataUrl });
    } else if (serviceState.status === 'ready') {
        res.json({ success: true, message: 'Already connected', connectedAs: serviceState.connectedNumber });
    } else {
        res.json({ success: false, status: serviceState.status, message: 'QR not available' });
    }
});

app.post('/send', async (req, res) => {
    if (serviceState.status !== 'ready' || !sock) {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing to or message' });
    }

    try {
        const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
        const result = await sock.sendMessage(jid, { text: message });
        serviceState.messagesSent++;
        serviceState.lastActivity = new Date().toISOString();
        res.json({ success: true, messageId: result?.key?.id });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/refresh-qr', async (req, res) => {
    console.log('Refresh requested');
    try {
        if (sock) { try { sock.end(); } catch(e){} }
        if (fs.existsSync(AUTH_PATH)) {
            fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        }
        serviceState.status = 'initializing';
        serviceState.qrCode = null;
        serviceState.qrCodeDataUrl = null;
        serviceState.connectedNumber = null;
        serviceState.connectedName = null;
        connectionAttempts = 0;
        setTimeout(startConnection, 500);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
    } catch(e) {}
    
    if (fs.existsSync(AUTH_PATH)) {
        fs.rmSync(AUTH_PATH, { recursive: true, force: true });
    }
    serviceState.status = 'logged_out';
    serviceState.connectedNumber = null;
    serviceState.connectedName = null;
    connectionAttempts = 0;
    setTimeout(startConnection, 1000);
    res.json({ success: true });
});

app.get('/messages', (req, res) => {
    res.json({ messages: messageHistory.slice(0, 50) });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, status: serviceState.status, version: serviceState.version });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log('SAN-IA WhatsApp v2.4 on port ' + PORT);
    startConnection();
});

process.on('SIGTERM', () => {
    if (sock) sock.end();
    process.exit(0);
});
