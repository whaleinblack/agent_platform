import {randomBytes, createHmac, timingSafeEqual} from 'node:crypto';

const lifetime = 7 * 24 * 60 * 60 * 1000,cookieName = 'agent_coord_owner';
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 256 || b.length > 256) return false;
  const first = Buffer.from(a),second = Buffer.from(b);return first.length === second.length && timingSafeEqual(first, second);
};

export class OwnerAccess {
  constructor(getSecret, now = Date.now) {this.getSecret = getSecret;this.now = now;this.tickets = new Map();}
  sign(value) {return createHmac('sha256', this.getSecret()).update(value).digest('hex');}
  issueTicket() {
    for (const [ticket, expires] of this.tickets) if (expires < this.now()) this.tickets.delete(ticket);
    if (this.tickets.size >= 50) this.tickets.delete(this.tickets.keys().next().value);
    const ticket = randomBytes(32).toString('hex'),expires = this.now() + 60000;this.tickets.set(ticket, expires);return {ticket,expiresAt: new Date(expires).toISOString()};
  }
  cookie(headers) {
    const raw = String(headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!raw || raw.length > 200) return null;
    const [id, expiry, signature, extra] = raw.split('.');
    if (extra !== undefined || !/^[a-f0-9]{32}$/.test(id || '') || !/^\d{1,16}$/.test(expiry || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
    const expires = Number(expiry);if (!Number.isSafeInteger(expires) || expires <= this.now() || expires > this.now() + lifetime + 60000 || !equal(signature, this.sign(`cookie|${id}|${expiry}`))) return null;
    return raw;
  }
  apiToken(cookie) {return this.sign('api|' + cookie);}
  resolveToken(token, headers) {const cookie = this.cookie(headers);return cookie && equal(token, this.apiToken(cookie)) ? this.getSecret() : token;}
  canBootstrap(token, headers) {return !!this.cookie(headers) || equal(token, this.getSecret());}
  bootstrapToken(token, headers) {const cookie = this.cookie(headers);return cookie ? this.apiToken(cookie) : token;}
  redeem(ticket) {
    const expires = this.tickets.get(ticket);this.tickets.delete(ticket);
    if (!expires || expires <= this.now()) return null;
    const id = randomBytes(16).toString('hex'),expiry = this.now() + lifetime,cookie = `${id}.${expiry}.${this.sign(`cookie|${id}|${expiry}`)}`;
    return {token: this.apiToken(cookie),setCookie: `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}`};
  }
}
