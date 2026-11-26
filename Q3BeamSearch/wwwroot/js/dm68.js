// wwwroot/js/dm68.js
// Quake 3 demo (.dm_68, protocol 68) reader: the server info and the recording player's
// playerState in every snapshot. Ported from oDFe:
//   qcommon/huffman_static.c   the fixed Huffman code of every message
//   qcommon/msg.c              MSG_ReadBits / ReadString, MSG_ReadDeltaPlayerstate
//   client/cl_parse.c          CL_ParseServerMessage, CL_ParseGamestate, CL_ParseSnapshot
// Entities aren't decoded: a snapshot's player state comes before its entities, and nothing
// after them is needed (a gamestate's baselines come after its configstrings, likewise).

// HuffmanEncoderTable: per byte, (code << 4) | bit count; codes are sent low bit first
const ENCODER = [
    34, 437, 1159, 1735, 2584, 280, 263, 1014, 341, 839, 1687, 183, 311, 726, 920, 2761,
    599, 1417, 7945, 8073, 7642, 16186, 8890, 12858, 3913, 6362, 2746, 13882, 7866, 1080, 1273, 3400,
    886, 3386, 1097, 11482, 15450, 16282, 12506, 15578, 2377, 6858, 826, 330, 10010, 12042, 8009, 1928,
    631, 3128, 3832, 6521, 1336, 2840, 217, 5657, 121, 3865, 6553, 6426, 4666, 3017, 5193, 7994,
    3320, 1287, 1991, 71, 536, 1304, 2057, 1801, 5081, 1594, 11642, 14106, 6617, 10938, 7290, 13114,
    4809, 2522, 5818, 14010, 7482, 5914, 7738, 9018, 3450, 11450, 5897, 2697, 3193, 4185, 3769, 3464,
    3897, 968, 6841, 6393, 2425, 775, 1048, 5369, 454, 648, 3033, 3145, 2440, 2297, 200, 2872,
    2136, 2248, 1144, 1944, 1431, 1031, 376, 408, 1208, 3608, 2616, 1848, 1784, 1671, 135, 1623,
    502, 663, 1223, 2007, 248, 2104, 24, 2168, 1656, 3704, 1400, 1864, 7353, 7241, 2073, 1241,
    4889, 5690, 6153, 15738, 698, 5210, 1722, 986, 12986, 3994, 3642, 9306, 4794, 794, 16058, 7066,
    4425, 8090, 4922, 714, 11738, 7194, 12762, 7450, 5001, 1562, 11834, 13402, 9914, 3290, 3258, 5338,
    905, 15386, 9178, 15306, 3162, 15050, 15930, 10650, 15674, 8522, 8250, 7114, 10714, 14362, 9786, 2266,
    1352, 4153, 1496, 518, 151, 15482, 12410, 2952, 7961, 8906, 1114, 58, 4570, 7258, 13530, 474,
    9, 15258, 3546, 6170, 4314, 2970, 7386, 14666, 7130, 6474, 14554, 5514, 15322, 3098, 15834, 3978,
    3353, 2329, 2458, 12170, 570, 1818, 11578, 14618, 1175, 8986, 4218, 9754, 8762, 392, 8282, 11290,
    7546, 3850, 11354, 12298, 15642, 14986, 8666, 20491, 90, 13706, 12186, 6794, 11162, 10458, 759, 582
];

// HuffmanDecoderTable, built from it: the next 11 bits → (code length << 8) | byte. The one
// 11-bit code no byte has (the adaptive coder's "not yet transmitted") reads as a 0, as there.
const DECODER = new Uint16Array(2048).fill((11 << 8) | 0);
ENCODER.forEach((e, sym) => {
    const len = e & 15, code = (e >> 4) & 0x7ff;
    for (let hi = 0; hi < 2048 >> len; hi++) DECODER[code | (hi << len)] = (len << 8) | sym;
});

const SVC_NOP = 1, SVC_GAMESTATE = 2, SVC_CONFIGSTRING = 3, SVC_SERVERCOMMAND = 5, SVC_SNAPSHOT = 7, SVC_EOF = 8;
const MAX_STRING_CHARS = 1024, BIG_INFO_STRING = 8192;
const FLOAT_INT_BITS = 13, FLOAT_INT_BIAS = 1 << 12;
export const ENTITYNUM_NONE = 1023;   // groundEntityNum in the air

const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
const intBitsToFloat = v => { i32[0] = v; return f32[0]; };

// One server message, read as msg.c reads a non-OOB msg_t
class Msg {
    constructor(bytes) {
        this.data = new Uint8Array(bytes.length + 4);   // zero padding: the decoder looks 11 bits ahead
        this.data.set(bytes);
        this.size = bytes.length;
        this.bit = 0;
    }

    get readcount() { return (this.bit >> 3) + 1; }

    // MSG_ReadBits: the low (bits & 7) bits raw, then Huffman-coded bytes; negative = signed
    bits(n) {
        const sgn = n < 0;
        if (sgn) n = -n;
        if (this.bit >= this.size * 8) return 0;
        const d = this.data, nbits = n & 7;
        let bit = this.bit, value = 0;
        for (let i = 0; i < nbits; i++, bit++) value |= ((d[bit >> 3] >> (bit & 7)) & 1) << i;
        n -= nbits;
        for (let i = 0; i < n; i += 8) {
            const at = bit >> 3;
            const e = DECODER[((d[at] | d[at + 1] << 8 | d[at + 2] << 16) >>> (bit & 7)) & 0x7ff];
            value |= (e & 0xff) << (i + nbits);
            bit += e >> 8;
        }
        this.bit = bit;
        // msg.c sign-extends with the byte-coded part's width (every signed field is whole bytes)
        if (sgn && n > 0 && n < 32 && value & (1 << (n - 1))) value |= -1 ^ ((1 << n) - 1);
        return value;
    }

    // -1 once past the end, like MSG_ReadByte / Short / Long
    byte() { const c = this.bits(8) & 0xff; return this.readcount > this.size ? -1 : c; }
    short() { const c = (this.bits(16) << 16) >> 16; return this.readcount > this.size ? -1 : c; }
    long() { const c = this.bits(32); return this.readcount > this.size ? -1 : c; }

    // MSG_ReadString / ReadBigString: '%' and bytes over 127 become '.'
    string(max = MAX_STRING_CHARS) {
        let s = '';
        for (;;) {
            const c = this.byte();
            if (c <= 0 || s.length >= max - 1) return s;
            s += String.fromCharCode(c === 37 || c > 127 ? 46 : c);
        }
    }
}

// msg.c playerStateFields, in wire order: [name, bits], 0 = float
const PS_FIELDS = [
    ['commandTime', 32], ['origin0', 0], ['origin1', 0], ['bobCycle', 8], ['velocity0', 0], ['velocity1', 0],
    ['viewangles1', 0], ['viewangles0', 0], ['weaponTime', -16], ['origin2', 0], ['velocity2', 0], ['legsTimer', 8],
    ['pm_time', -16], ['eventSequence', 16], ['torsoAnim', 8], ['movementDir', 4], ['events0', 8], ['legsAnim', 8],
    ['events1', 8], ['pm_flags', 16], ['groundEntityNum', 10], ['weaponstate', 4], ['eFlags', 16],
    ['externalEvent', 10], ['gravity', 16], ['speed', 16], ['delta_angles1', 16], ['externalEventParm', 8],
    ['viewheight', -8], ['damageEvent', 8], ['damageYaw', 8], ['damagePitch', 8], ['damageCount', 8],
    ['generic1', 8], ['pm_type', 8], ['delta_angles0', 16], ['delta_angles2', 16], ['torsoTimer', 12],
    ['eventParms0', 8], ['eventParms1', 8], ['clientNum', 8], ['weapon', 5], ['viewangles2', 0],
    ['grapplePoint0', 0], ['grapplePoint1', 0], ['grapplePoint2', 0], ['jumppad_ent', 10], ['loopSound', 16]
];
const EMPTY_PS = Object.freeze({
    ...Object.fromEntries(PS_FIELDS.map(([name]) => [name, 0])),
    stats: new Array(16).fill(0), persistant: new Array(16).fill(0), ammo: new Array(16).fill(0), powerups: new Array(16).fill(0)
});

// MSG_ReadDeltaPlayerstate
function readPlayerstate(msg, from = EMPTY_PS) {
    const to = { ...from, stats: [...from.stats], persistant: [...from.persistant], ammo: [...from.ammo], powerups: [...from.powerups] };
    const lc = msg.byte();
    if (lc < 0 || lc > PS_FIELDS.length) throw new Error('invalid playerState field count');
    for (let i = 0; i < lc; i++) {
        if (!msg.bits(1)) continue;   // unchanged
        const [name, bits] = PS_FIELDS[i];
        if (bits) to[name] = msg.bits(bits);
        else if (!msg.bits(1)) to[name] = msg.bits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;   // integral float
        else to[name] = intBitsToFloat(msg.bits(32));
    }
    if (msg.bits(1)) {
        for (const [key, read] of [['stats', 'short'], ['persistant', 'short'], ['ammo', 'short'], ['powerups', 'long']]) {
            if (!msg.bits(1)) continue;
            const mask = msg.bits(16);
            for (let i = 0; i < 16; i++) if (mask & (1 << i)) to[key][i] = msg[read]();
        }
    }
    return to;
}

// "\key\value\key\value" → { key: value }
export function parseInfo(s) {
    const parts = s.split('\\'), info = {};
    for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i].toLowerCase()] = parts[i + 1];
    return info;
}

// buffer: the .dm_68 file. Returns { configStrings: {index: string}, info: the server info
// (CS_SERVERINFO, keys lowercased), snapshots: [{ serverTime, ps }] in file order }.
// A demo file is a run of [int32 message sequence][int32 length][message], ended by a length of -1.
export function parseDemo(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const configStrings = {}, snapshots = [], byMessage = new Map();
    for (let pos = 0; pos + 8 <= bytes.length;) {
        const sequence = view.getInt32(pos, true), length = view.getInt32(pos + 4, true);
        pos += 8;
        if (length < 0 || pos + length > bytes.length) break;
        const msg = new Msg(bytes.subarray(pos, pos + length));
        pos += length;
        msg.long();   // reliableAcknowledge
        for (let cmd = msg.byte(); cmd !== SVC_EOF && cmd >= 0; cmd = msg.byte()) {
            if (cmd === SVC_NOP) continue;
            if (cmd === SVC_SERVERCOMMAND) { msg.long(); msg.string(); continue; }
            if (cmd === SVC_GAMESTATE) {
                msg.long();   // serverCommandSequence
                for (let c = msg.byte(); c === SVC_CONFIGSTRING; c = msg.byte()) {
                    const index = msg.short();
                    configStrings[index] = msg.string(BIG_INFO_STRING);
                }
                break;   // baselines next
            }
            if (cmd === SVC_SNAPSHOT) {
                const serverTime = msg.long(), deltaNum = msg.byte();
                msg.byte();   // snapFlags
                for (let n = msg.byte(); n > 0; n--) msg.byte();   // areamask
                const delta = deltaNum ? sequence - deltaNum : -1;
                const from = delta > 0 ? byMessage.get(delta) : EMPTY_PS;
                if (from) {   // a delta from a message not in the file can't be read
                    const ps = readPlayerstate(msg, from);
                    byMessage.set(sequence, ps);
                    byMessage.delete(sequence - 64);   // the server deltas from the last 32 at most
                    snapshots.push({ serverTime, ps });
                }
                break;   // entities next
            }
            throw new Error(`not a protocol 68 demo (server message ${cmd})`);
        }
    }
    return { configStrings, info: parseInfo(configStrings[0] ?? ''), snapshots };
}

// DeFRaG puts the keys held in ps.stats[13] and its race timer (ms) in ps.stats[8]. Forward, left,
// right and jump were read off a demo against movementDir and the jumps; back = 2 is assumed
// (the next free bit, never held in that demo).
const DF_FORWARD = 1, DF_BACK = 2, DF_LEFT = 8, DF_RIGHT = 16, DF_JUMP = 32;

// One viewer frame (y = -Q3 y), `t` of the way from player state a to b
function toFrame(a, b, t, defrag) {
    const lerp = (p, q) => p + (q - p) * t;
    const vx = lerp(a.velocity0, b.velocity0), vy = lerp(a.velocity1, b.velocity1);
    const k = defrag ? b.stats[13] : 0;
    const axis = (plus, minus) => (k & plus ? 127 : 0) - (k & minus ? 127 : 0);
    return {
        x: lerp(a.origin0, b.origin0), y: -lerp(a.origin1, b.origin1), z: lerp(a.origin2, b.origin2),
        vx, vy, speed: Math.hypot(vx, vy),
        yawDeg: b.viewangles1, yawShort: Math.round(b.viewangles1 * 65536 / 360) & 0xffff,
        onGround: b.groundEntityNum !== ENTITYNUM_NONE,
        forwardMove: axis(DF_FORWARD, DF_BACK), rightMove: axis(DF_RIGHT, DF_LEFT), upMove: k & DF_JUMP ? 127 : 0,
        buttons: 0, ...(defrag ? { timerMs: b.stats[8] } : {})
    };
}

// The demo as viewer frames, one per 8 ms of the player's commandTime (pmove_msec 8): a snapshot
// with no new command is dropped, and a gap (two commands in one snapshot, a lag spike) is filled
// in a straight line. From the first PM_NORMAL snapshot to the next that isn't (DeFRaG freezes the
// player at the finish). Without DeFRaG's key bits the keys are 0.
export function demoFrames(demo) {
    const defrag = demo.info.gamename === 'defrag', live = [];
    for (const { ps } of demo.snapshots) {
        if (ps.pm_type !== 0) { if (live.length) break; continue; }
        if (!live.length || ps.commandTime > live.at(-1).commandTime) live.push(ps);
    }
    const frames = [];
    live.forEach((ps, i) => {
        const prev = live[i - 1];
        if (prev) for (let t = prev.commandTime + 8; t < ps.commandTime; t += 8)
            frames.push(toFrame(prev, ps, (t - prev.commandTime) / (ps.commandTime - prev.commandTime), defrag));
        frames.push(toFrame(ps, ps, 0, defrag));
    });
    frames.forEach((f, i) => { f.frame = i; });
    return frames;
}
