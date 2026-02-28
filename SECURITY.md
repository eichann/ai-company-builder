# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

Please use [GitHub Security Advisories](https://github.com/eichann/ai-company-builder/security/advisories/new) to report vulnerabilities privately. This allows us to discuss and fix the issue before public disclosure.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix release**: Depends on severity

### Scope

This policy applies to:
- The API server (`server/`)
- The Electron desktop app (`client/`)
- The admin panel (`admin/`)
- Self-hosting configurations (`docs/self-hosting/`)

### Out of Scope

- Vulnerabilities in third-party dependencies (report to the upstream project)
- Social engineering attacks
- Denial of service attacks

## Security Design

### Authentication
- Session-based auth via Better Auth
- Passwords hashed with bcrypt (via Better Auth defaults)
- Session tokens are HMAC-signed cookies

### Data Storage
- All data stored locally on your self-hosted server
- SQLite databases (no external database service)
- Git bare repositories for file storage

### Git Transport
- HTTPS only (SSH support removed)
- Session token authentication via GIT_ASKPASS
- No credentials stored on disk

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |
