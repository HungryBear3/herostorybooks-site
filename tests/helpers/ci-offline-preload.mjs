// Catch unmatched outbound before SDK imports; tests may replace fetch with fakes.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { console.error('UNEXPECTED_NETWORK_ATTEMPT_BLOCKED'); throw new Error('UNEXPECTED_NETWORK_ATTEMPT_BLOCKED'); };
globalThis.fetch = blocked;
http.request = blocked; http.get = blocked; https.request = blocked; https.get = blocked;
net.connect = blocked; net.createConnection = blocked;
syncBuiltinESMExports();
