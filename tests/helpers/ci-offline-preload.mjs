// Catch unmatched outbound before SDK imports; tests may replace fetch with fakes.
// Finite in-process JS containment for HTTP/TCP/TLS: the socket-prototype and
// tls.connect backstops also stop direct sockets, TLSSockets and agents that
// captured createConnection. Not an OS sandbox: subprocesses, UDP and native
// bindings are outside its reach.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { console.error('UNEXPECTED_NETWORK_ATTEMPT_BLOCKED'); throw new Error('UNEXPECTED_NETWORK_ATTEMPT_BLOCKED'); };
globalThis.fetch = blocked;
http.request = blocked; http.get = blocked; https.request = blocked; https.get = blocked;
net.connect = blocked; net.createConnection = blocked;
net.Socket.prototype.connect = blocked; tls.connect = blocked;
syncBuiltinESMExports();
