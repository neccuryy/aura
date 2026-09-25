import sharp from "sharp";
import Vibrant from "node-vibrant";

export interface Palette {
	darkMuted?: string;
	darkVibrant?: string;
	vibrant?: string;
	muted?: string;
	lightMuted?: string;
}

export async function extractPalette(art: Buffer): Promise<Palette | null> {
	try {
		const small = await sharp(art).resize(64, 64, { fit: "cover" }).png().toBuffer();
		const palette = await new Vibrant(small, { colorCount: 16, quality: 1 }).getPalette();
		if (!palette) return null;
		return {
			darkMuted: palette.DarkMuted?.hex,
			darkVibrant: palette.DarkVibrant?.hex,
			vibrant: palette.Vibrant?.hex,
			muted: palette.Muted?.hex,
			lightMuted: palette.LightMuted?.hex
		};
	} catch (_e) {
		return null;
	}
}
