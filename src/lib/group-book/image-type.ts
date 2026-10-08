export interface GroupBookImageType {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
  ext: 'jpg' | 'png' | 'webp' | 'heic';
}

export function sniffGroupBookImage(header: Uint8Array): GroupBookImageType | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 &&
    header[3] === 0x46 && header[8] === 0x57 && header[9] === 0x45 &&
    header[10] === 0x42 && header[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  const brand = String.fromCharCode(...Array.from(header.slice(4, 12)));
  if (/ftyp(heic|heix|hevc|heif|mif1)/i.test(brand)) {
    return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}

export async function resolveGroupBookImage(file: File): Promise<GroupBookImageType | null> {
  const sniffed = sniffGroupBookImage(
    new Uint8Array(await file.slice(0, 16).arrayBuffer()),
  );
  if (!sniffed) return null;
  const declared = file.type === 'image/jpg' ? 'image/jpeg' :
    file.type === 'image/heif' ? 'image/heic' : file.type;
  if (declared && declared !== 'application/octet-stream' && declared !== sniffed.mime) {
    return null;
  }
  return sniffed;
}
