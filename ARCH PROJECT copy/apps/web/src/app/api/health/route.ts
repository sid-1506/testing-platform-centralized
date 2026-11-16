import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'web-app',
    port: process.env.PORT || 3000,
    timestamp: new Date().toISOString(),
  });
}
