import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import QRCode from "qrcode";

import { logger } from "../util/logger.js";

const LOGIN_QR_DIR = path.join(os.tmpdir(), "weixin-agent-sdk", "login-qrs");

export type LoginQrCodeInfo = {
  sessionKey: string;
  qrcodeUrl: string;
  refreshed: boolean;
  imagePath?: string;
};

export async function writeLoginQrImage(
  sessionKey: string,
  qrcodeUrl: string,
): Promise<string | undefined> {
  try {
    await fs.mkdir(LOGIN_QR_DIR, { recursive: true });
    const imagePath = path.join(LOGIN_QR_DIR, `${sessionKey}.png`);
    await QRCode.toFile(imagePath, qrcodeUrl, {
      width: 360,
      margin: 1,
    });
    return imagePath;
  } catch (err) {
    logger.warn(`writeLoginQrImage failed: ${String(err)}`);
    return undefined;
  }
}

