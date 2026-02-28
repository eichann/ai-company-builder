import { NextRequest, NextResponse } from 'next/server'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

async function proxyRequest(request: NextRequest) {
  const url = new URL(request.url)
  const targetUrl = `${API_URL}${url.pathname}${url.search}`

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    // Skip host header
    if (key.toLowerCase() !== 'host') {
      headers.set(key, value)
    }
  })

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is needed for streaming body
    duplex: 'half',
  })

  const responseHeaders = new Headers()
  response.headers.forEach((value, key) => {
    responseHeaders.set(key, value)
  })

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

export async function GET(request: NextRequest) {
  return proxyRequest(request)
}

export async function POST(request: NextRequest) {
  return proxyRequest(request)
}

export async function PUT(request: NextRequest) {
  return proxyRequest(request)
}

export async function DELETE(request: NextRequest) {
  return proxyRequest(request)
}

export async function PATCH(request: NextRequest) {
  return proxyRequest(request)
}

export async function OPTIONS(request: NextRequest) {
  return proxyRequest(request)
}
