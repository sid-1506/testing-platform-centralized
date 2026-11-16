import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'hybrid-frontend',
    port: process.env.PORT || 3004,
    timestamp: new Date().toISOString(),
  });
}
