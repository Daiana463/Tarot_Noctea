# NOCTEA — Landing page de reservas

Landing premium de tarot y lecturas espirituales. Sistema completo con calendario real (Google Calendar), Stripe Bizum, transferencia bancaria y envío de email automático.

---

## Estructura del proyecto

```
noctea-landing/
  frontend/
    index.html          ← Landing principal
    styles.css          ← Estilos (paleta verde/crema/dorado)
    app.js              ← Lógica de booking, pago y cookies
    assets/
      README.md         ← Instrucciones para imágenes
    legal/
      aviso-legal.html
      politica-privacidad.html
      politica-cookies.html
      condiciones-contratacion.html
    robots.txt          ← Bloquea /legal/ de indexación
  backend/
    server.js           ← Express API
    package.json
    .env.example        ← Variables de entorno (copiar a .env)
  README.md             ← Este archivo
```

---

## 1. Instalación

### Requisitos
- Node.js 18 o superior
- npm

### Instalar dependencias del backend

```bash
cd noctea-landing/backend
npm install
```

---

## 2. Variables de entorno

```bash
# Dentro de backend/
cp .env.example .env
```

Editar `.env` con las credenciales reales (ver secciones siguientes).

**Nunca subas el archivo `.env` a git.** Ya está incluido en `.gitignore` si lo configuras.

---

## 3. Ejecutar el backend

```bash
cd noctea-landing/backend
npm run dev       # desarrollo con hot-reload (nodemon)
# o
npm start         # producción
```

El servidor arranca en `http://localhost:3000`.

### Endpoints disponibles

| Método | Ruta                          | Descripción                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/api/health`                 | Verificar que el servidor funciona   |
| GET    | `/api/availability?date=...`  | Consultar horarios disponibles       |
| POST   | `/api/create-checkout-session`| Crear sesión Stripe (Bizum)          |
| POST   | `/api/stripe-webhook`         | Webhook de Stripe (post-pago)        |
| POST   | `/api/transfer-booking`       | Confirmar reserva por transferencia  |

---

## 4. Abrir el frontend

Con el backend corriendo, abre `frontend/index.html` directamente en el navegador.  
Para producción, sirve la carpeta `frontend/` con un servidor estático (Netlify, Vercel, nginx, etc.).

> El frontend funciona en modo demo incluso sin backend (muestra horarios de ejemplo).

---

## 5. Stripe — Configurar Bizum

### Obtener claves

1. Ir a [dashboard.stripe.com](https://dashboard.stripe.com)
2. Crear cuenta o iniciar sesión
3. En **Developers → API Keys** copiar:
   - `STRIPE_SECRET_KEY` → `sk_test_xxxxx` (test) o `sk_live_xxxxx` (producción)

### Configurar webhook

1. En Stripe: **Developers → Webhooks → Add endpoint**
2. URL del endpoint: `https://tudominio.com/api/stripe-webhook`
3. Evento a escuchar: `checkout.session.completed`
4. Copiar el **Signing secret** en `STRIPE_WEBHOOK_SECRET`

### Bizum en Stripe

Bizum está disponible en Stripe para cuentas con domicilio en España.  
Si Bizum no aparece como opción, verificar que la cuenta esté activada para pagos en EUR/ES.

### Probar localmente con Stripe CLI

```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

Esto te dará un `whsec_xxx` temporal para desarrollo.

---

## 6. Google Calendar API

### Paso a paso para obtener el refresh token

1. Ir a [console.cloud.google.com](https://console.cloud.google.com)
2. Crear un proyecto nuevo o usar uno existente
3. Activar la **Google Calendar API**
4. Crear credenciales OAuth 2.0 (tipo: aplicación web)
5. Añadir como URI de redirección: `http://localhost:3000/oauth2callback`
6. Copiar `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env`
7. Generar la URL de autorización:

```
https://accounts.google.com/o/oauth2/auth
  ?client_id=TU_CLIENT_ID
  &redirect_uri=http://localhost:3000/oauth2callback
  &scope=https://www.googleapis.com/auth/calendar
  &response_type=code
  &access_type=offline
  &prompt=consent
```

8. Abre esa URL en el navegador, autoriza con la cuenta de Google del calendario de NOCTEA
9. Serás redirigido a `http://localhost:3000/oauth2callback?code=...`
10. El servidor mostrará el `refresh_token` en pantalla
11. Copiar ese token en `GOOGLE_REFRESH_TOKEN` en `.env`

### Timezone

El backend usa `Europe/Madrid`. Si estás en otra zona horaria, cambiar en `server.js` las referencias a `Europe/Madrid`.

---

## 7. Web3Forms — Email automático

1. Ir a [web3forms.com](https://web3forms.com)
2. Crear cuenta gratuita (hasta 250 emails/mes gratis)
3. Crear un nuevo formulario con el email destino: `nocteatarot@gmail.com`
4. Copiar el **Access Key** en `WEB3FORMS_ACCESS_KEY`

Los emails se envían cuando:
- Se confirma un pago con Bizum (via webhook de Stripe)
- Se confirma una reserva con transferencia bancaria

---

## 8. Cambiar el IBAN

En `.env`:
```
BANK_ACCOUNT_HOLDER=NOCTEA
BANK_IBAN=ES00 0000 0000 0000 0000 0000
```

El IBAN aparece en:
- El paso 4 del formulario de reserva (datos de transferencia)
- La pantalla de confirmación de transferencia
- El email enviado al cliente

---

## 9. Publicar el proyecto

### Frontend (Netlify / Vercel)

```bash
# Netlify: arrastra la carpeta frontend/ al panel
# O usando CLI:
netlify deploy --dir=frontend --prod
```

Actualiza `DOMAIN_URL` en `.env` con la URL real de producción.

### Backend (Railway / Render / VPS)

1. Subir el contenido de `backend/` al servidor
2. Configurar las variables de entorno en el panel de la plataforma
3. `npm install && npm start`
4. Actualizar la URL del webhook en Stripe con la URL real

### CORS en producción

En `server.js`, restringir el origen de CORS:
```js
app.use(cors({ origin: 'https://tudominio.com' }));
```

---

## 10. Qué falta para producción

- [ ] Credenciales Stripe reales (live mode)
- [ ] Google Calendar OAuth2 refresh token real
- [ ] Web3Forms access key real
- [ ] IBAN bancario real
- [ ] CORS restringido al dominio real
- [ ] HTTPS en el servidor (requerido por Stripe)
- [ ] Variables de entorno configuradas en el hosting
- [ ] `DOMAIN_URL` apuntando al dominio real
- [ ] Datos del titular en páginas legales (NIF, domicilio)
- [ ] Favicon y OG image en `assets/`
- [ ] Revisar compatibilidad de Bizum con la cuenta Stripe

---

## 11. Editar páginas legales

Las páginas legales están en `frontend/legal/`. Cada una tiene marcadores `[placeholder]` que debes completar:

- `[Nombre completo del titular]` — nombre real del autónomo/empresa
- `[NIF/CIF]` — número de identificación fiscal
- `[Domicilio fiscal]` — dirección completa
- `[Plazo de conservación]` — según obligaciones contables (normalmente 5 años)

Busca todos los placeholders con: `Ctrl+F` → `[`

---

## 12. noindex en páginas legales (doble protección)

**Nivel 1 — robots.txt** (`frontend/robots.txt`):
```
User-agent: *
Disallow: /legal/
```

**Nivel 2 — meta tags** (en cada página legal):
```html
<meta name="robots" content="noindex, nofollow">
<meta name="googlebot" content="noindex, nofollow">
```

Las páginas legales solo están enlazadas desde el footer. No aparecen en el menú de navegación principal.

---

## 13. Gestión de cookies

El banner de cookies está implementado en `frontend/index.html` y manejado en `app.js`.

**Cómo funciona:**
- Al primer acceso, aparece el banner
- Las opciones son: Aceptar, Rechazar, Configurar
- La elección se guarda en `localStorage` como `noctea_cookie_consent`
- Las cookies analíticas no se activan hasta recibir consentimiento explícito
- Desde `frontend/legal/politica-cookies.html` el usuario puede resetear su elección

**Para añadir analítica real** (Google Analytics, Plausible, etc.):
1. Añadir el script de analítica **solo** dentro del bloque `if analytics` en `app.js`
2. Verificar que no se carga antes del consentimiento

---

## Paleta de colores

| Variable          | Hex       | Uso                       |
|-------------------|-----------|---------------------------|
| `--verde-noche`   | `#061A12` | Fondos oscuros, header    |
| `--verde-bosque`  | `#123C24` | Fondos secundarios        |
| `--verde-hoja`    | `#2F6B3C` | Botones, acentos          |
| `--verde-salvia`  | `#DCE8D6` | Fondos suaves, bordes     |
| `--crema`         | `#F7F3EA` | Fondo principal           |
| `--dorado`        | `#C9A85A` | Detalles, precios         |
| `--negro`         | `#151515` | Texto principal           |
| `--blanco`        | `#FFFDF7` | Texto sobre fondo oscuro  |
