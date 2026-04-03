import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
  const form = await request.formData();
  const data: Record<string, any> = {};
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      const buffer = Buffer.from(await value.arrayBuffer());
      const uploadDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
      const filePath = path.join(uploadDir, value.name);
      fs.writeFileSync(filePath, buffer);
      data[key] = filePath;
    } else {
      data[key] = value;
    }
  }
  const ordersPath = path.join(process.cwd(), 'orders.json');
  let orders = [];
  if (fs.existsSync(ordersPath)) {
    orders = JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
  }
  orders.push({ id: Date.now(), ...data });
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
  return NextResponse.redirect(new URL('/thank-you', request.url));
}
