const fs = require('fs');
const path = require('path');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'silent' });

let serviceState = {
    status: 'initializing',
    qrCode: null,
    qrCodeDataUrl: null,
    connectedNumber: null,
    connectedName: null,
    lastActivity: null,
    messagesSent: 0,
    messagesReceived: 0,
    version: '2.2-baileys-render'
};

let messageHistory = [];
const MAX_HISTORY = 100;
let sock = null;
let isConnecting = false;
let retryCount = 0;
const MAX_RETRIES = 5;

const AUTH_PATH = path.join(__dirname, '.baileys_auth');

async function connectToWhatsApp() {
    if (isConnecting) {
        console.log('Connection already in progress...');
        return;
    }
    
    isConnecting = true;
    serviceState.status = 'connecting';
    
    try {
        if (!fs.existsSync(AUTH_PATH)) {
            fs.mkdirSync(AUTH_PATH, { recursive: true });
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        
        console.log(`Starting Baileys connection (attempt ${retryCount + 1}/${MAX_RETRIES})`);

        sock = makeWASocket({
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: true,
            browser: ['SAN-IA CRM', 'Safari', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR Code generated!');
                retryCount = 0;
                serviceState.status = 'qr_ready';
                serviceState.qrCode = qr;
                try {
                    serviceState.qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                    console.log('QR Code ready for scanning');
                } catch (err) {
                    console.error('QR generation error:', err.message);
                }
            }

            if (connection === 'open') {
                console.log('WhatsApp connected successfully!');
                isConnecting = false;
                retryCount = 0;
                serviceState.status = 'ready';
                serviceState.qrCode = null;
                serviceState.qrCodeDataUrl = null;
                serviceState.lastActivity = new Date().toISOString();
                try {
                    const user = sock.user;
                    if (user) {
                        serviceState.connectedNumber = user.id.split(':')[0].split('@')[0];
                        serviceState.connectedName = user.name || user.verifiedName || 'WhatsApp User';
                        console.log(`Connected as: ${serviceState.connectedName} (${serviceState.connectedNumber})`);
                    }
                } catch (err) {}
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : null;
                const reason = DisconnectReason[statusCode] || statusCode || 'unknown';
                console.log(`Connection closed. Reason: ${reason} (${statusCode})`);
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('Logged out - need new QR scan');
                    serviceState.status = 'logged_out';
                    serviceState.connectedNumber = null;
                    serviceState.connectedName = null;
                    if (fs.existsSync(AUTH_PATH)) {
                        fs.rmSync(AUTH_PATH, { recursive: true, force: true });
                    }
                    retryCount = 0;
                    setTimeout(connectToWhatsApp, 3000);
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log('Restart required - reconnecting...');
                    retryCount = 0;
                    setTimeout(connectToWhatsApp, 1000);
                } else if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    const delay = Math.min(retryCount * 5000, 30000);
                    console.log(`Reconnecting in ${delay/1000}s... (attempt ${retryCount}/${MAX_RETRIES})`);
                    serviceState.status = 'reconnecting';
                    setTimeout(connectToWhatsApp, delay);
                } else {
                    console.log('Max retries reached - waiting for manual refresh');
                    serviceState.status = 'disconnected';
                    retryCount = 0;
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (event) => {
            const { messages, type } = event;
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe || !msg.message) continue;
                const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || '[Media]';
                const fromNumber = msg.key.remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
                serviceState.messagesReceived++;
                serviceState.lastActivity = new Date().toISOString();
                messageHistory.unshift({
                    id: msg.key.id,
                    from: fromNumber,
                    body: messageContent,
                    timestamp: new Date().toISOString(),
                    direction: 'incoming'
                });
                if (messageHistory.length > MAX_HISTORY) messageHistory.pop();
            }
        });

        console.log('Baileys client initialized');
        
    } catch (err) {
        console.error('Connection error:', err.message);
        isConnecting = false;
        serviceState.status = 'error';
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(connectToWhatsApp, 10000);
        }
    }
}

app.get('/status', (req, res) => res.json(serviceState));

app.get('/qr', (req, res) => {
    if (serviceState.qrCodeDataUrl) {
        res.json({ success: true, qrCodeDataUrl: serviceState.qrCodeDataUrl, message: 'Scan this QR code' });
    } else if (serviceState.status === 'ready') {
        res.json({ success: true, qrCodeDataUrl: null, message: 'Already connected', connectedAs: { number: serviceState.connectedNumber, name: serviceState.connectedName } });
    } else {
        res.json({ success: false, qrCodeDataUrl: null, message: `Status: ${serviceState.status}`, status: serviceState.status });
    }
});

app.post('/send', async (req, res) => {
    const { to, message } = req.body;
    if (serviceState.status !== 'ready') return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
    if (!to || !message) return res.status(400).json({ success: false, error: 'Missing parameters' });
    try {
        let jid = to.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const result = await sock.sendMessage(jid, { text: message });
        serviceState.messagesSent++;
        serviceState.lastActivity = new Date().toISOString();
        res.json({ success: true, messageId: result.key.id, to, timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/messages', (req, res) => {
    res.json({ success: true, count: messageHistory.length, messages: messageHistory.slice(0, parseInt(req.query.limit) || 50) });
});

app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        serviceState = { ...serviceState, status: 'disconnected', connectedNumber: null, connectedName: null, qrCode: null, qrCodeDataUrl: null };
        retryCount = 0;
        setTimeout(connectToWhatsApp, 2000);
        res.json({ success: true, message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/refresh-qr', async (req, res) => {
    try {
        console.log('Refresh QR requested');
        if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        serviceState.status = 'initializing';
        serviceState.qrCode = null;
        serviceState.qrCodeDataUrl = null;
        isConnecting = false;
        retryCount = 0;
        if (sock) {
            try { sock.end(); } catch(e) {}
        }
        setTimeout(connectToWhatsApp, 1000);
        res.json({ success: true, message: 'Refreshing QR...' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: serviceState.status, version: serviceState.version, retryCount }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`SAN-IA WhatsApp Service v2.2 - Port ${PORT}`);
    connectToWhatsApp();
});

process.on('SIGTERM', () => { if (sock) sock.end(); process.exit(0); });
