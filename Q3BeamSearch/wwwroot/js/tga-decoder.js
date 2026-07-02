// wwwroot/js/tga-decoder.js
// TGA decoder — Q3 PK3 archives store nearly all textures as TGA.
// Supports type 2 (uncompressed) and type 10 (RLE), 24/32-bit.
// Pure helpers (DOM only, no shared viewer state).

export function decodeTGA(buffer) {
    const dv  = new DataView(buffer);
    const idLen        = dv.getUint8(0);
    const colorMapType = dv.getUint8(1);
    const imageType    = dv.getUint8(2);
    const width        = dv.getUint16(12, true);
    const height       = dv.getUint16(14, true);
    const bpp          = dv.getUint8(16);
    const descriptor   = dv.getUint8(17);
    if (!width || !height) return null;
    if (bpp !== 24 && bpp !== 32) return null;
    if (imageType !== 2 && imageType !== 10) return null;
    const Bpp = bpp >> 3;
    const colorMapSize = colorMapType ? dv.getUint16(5, true) * Math.ceil(dv.getUint8(7) / 8) : 0;
    const dataOffset = 18 + idLen + colorMapSize;
    const raw = new Uint8Array(buffer);
    const out = new Uint8ClampedArray(width * height * 4);
    if (imageType === 2) {
        for (let i = 0; i < width * height; i++) {
            const p = dataOffset + i * Bpp, o = i * 4;
            out[o] = raw[p+2]; out[o+1] = raw[p+1]; out[o+2] = raw[p]; out[o+3] = Bpp === 4 ? raw[p+3] : 255;
        }
    } else {
        let i = 0, p = dataOffset;
        while (i < width * height) {
            const hdr = raw[p++], count = (hdr & 0x7f) + 1;
            if (hdr & 0x80) {
                const r = raw[p+2], g = raw[p+1], b = raw[p], a = Bpp === 4 ? raw[p+3] : 255;
                p += Bpp;
                for (let j = 0; j < count; j++) { const o=(i+j)*4; out[o]=r; out[o+1]=g; out[o+2]=b; out[o+3]=a; }
            } else {
                for (let j = 0; j < count; j++) { const o=(i+j)*4; out[o]=raw[p+2]; out[o+1]=raw[p+1]; out[o+2]=raw[p]; out[o+3]=Bpp===4?raw[p+3]:255; p+=Bpp; }
            }
            i += count;
        }
    }
    // Flip vertically when origin is bottom-left (bit 5 of descriptor = 0)
    if (!(descriptor & 0x20)) {
        const row = width * 4, tmp = new Uint8ClampedArray(row);
        for (let y = 0; y < height >> 1; y++) {
            const t = y * row, b = (height - 1 - y) * row;
            tmp.set(out.subarray(t, t + row));
            out.copyWithin(t, b, b + row);
            out.set(tmp, b);
        }
    }
    return new ImageData(out, width, height);
}

export function imageDataToCanvas(imgData) {
    const c = document.createElement('canvas');
    c.width = imgData.width; c.height = imgData.height;
    c.getContext('2d').putImageData(imgData, 0, 0);
    return c;
}
