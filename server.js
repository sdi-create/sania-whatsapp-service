const fs = require('fs');
const path = require('path');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
require('dotenv').config();

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
    version: '2.0-baileys-render'
};

let messageHistory = [];
const MAX_HISTORY = 100;
let sock = null;

const AUTH_PATH = path.join(__dirname, '.baileys_auth');

async function connectToWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_PATH)) {
            fs.mkdirSync(AUTH_PATH, { recursive: true });
        }
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Baileys v${version.join('.')} (latest: ${isLatest})`);

        sock = makeWASocket({
            version, logger, auth: state,
            printQRInTerminal: true,
            browser: ['SAN-IA CRM', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000, qrTimeout: 60000,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('QR Code genere');
                serviceState.status = 'qr_pending';
                serviceState.qrCode = qr;
                try { serviceState.qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 }); } catch (err) {}
            }
            if (connection === 'open') {
                console.log('WhatsApp connecte!');
                serviceState.status = 'ready';
                serviceState.qrCode = null;
                serviceState.qrCodeDataUrl = null;
                serviceState.lastActivity = new Date().toISOString();
                try {
                    const user = sock.user;
                    if (user) {
                        serviceState.connectedNumber = user.id.split(':')[0].split('@')[0];
                        serviceState.connectedName = user.name || user.verifiedName || 'WhatsApp User';
                    }
                } catch (err) {}
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (statusCode === DisconnectReason.loggedOut) {
                    serviceState.status = 'disconnected';
                    serviceState.connectedNumber = null;
                    serviceState.connectedName = null;
                } else if (shouldReconnect) {
                    serviceState.status = 'reconnecting';
                    setTimeout(connectToWhatsApp, 3000);
                } else { serviceState.status = 'disconnected'; }
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
                messageHistory.unshift({ id: msg.key.id, from: fromNumber, to: serviceState.connectedNumber, body: messageContent, timestamp: new Date().toISOString(), direction: 'incoming', fromName: msg.pushName || 'Inconnu' });
                if (messageHistory.length > MAX_HISTORY) messageHistory.pop();
            }
        });
    } catch (err) {
        console.error('Erreur:', err);
        serviceState.status = 'error';
        setTimeout(connectToWhatsApp, 10000);
    }
}

app.get('/status', (req, res) => res.json(serviceState));
app.get('/qr', (req, res) => {
    if (serviceState.status === 'qr_pending' && serviceState.qrCodeDataUrl) {
        res.json({ success: true, qrCodeDataUrl: serviceState.qrCodeDataUrl, message: 'Scannez ce QR code' });
    } else if (serviceState.status === 'ready') {
        res.json({ success: true, qrCodeDataUrl: null, message: 'WhatsApp deja connecte', connectedAs: { number: serviceState.connectedNumber, name: serviceState.connectedName } });
    } else { res.json({ success: false, qrCodeDataUrl: null, message: 'Service: ' + serviceState.status }); }
});
app.post('/send', async (req, res) => {
    const { to, message } = req.body;
    if (serviceState.status !== 'ready') return res.status(503).json({ success: false, error: 'WhatsApp non connecte' });
    if (!to || !message) return res.status(400).json({ success: false, error: 'Parametres manquants' });
    try {
        let jid = to.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const result = await sock.sendMessage(jid, { text: message });
        serviceState.messagesSent++;
        serviceState.lastActivity = new Date().toISOString();
        res.json({ success: true, messageId: result.key.id, to, timestamp: new Date().toISOString() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/messages', (req, res) => res.json({ success: true, count: messageHistory.length, messages: messageHistory.slice(0, parseInt(req.query.limit) || 50) }));
app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        serviceState = { ...serviceState, status: 'disconnected', connectedNumber: null, connectedName: null, qrCode: null, qrCodeDataUrl: null };
        setTimeout(connectToWhatsApp, 2000);
        res.json({ success: true, message: 'Deconnecte' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/refresh-qr', async (req, res) => {
    try {
        if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        serviceState.status = 'initializing';
        serviceState.qrCode = null;
        serviceState.qrCodeDataUrl = null;
        if (sock) sock.end();
        setTimeout(connectToWhatsApp, 1000);
        res.json({ success: true, message: 'Regeneration QR...' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: serviceState.status, version: serviceState.version }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => { console.log('SAN-IA WhatsApp Service - Port ' + PORT); connectToWhatsApp(); });
process.on('SIGTERM', () => { if (sock) sock.end(); process.exit(0); });
