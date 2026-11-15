# Monitor Switch 2 · Zelda 40th (Chile)

Bot que vigila la disponibilidad de la **Nintendo Switch 2 – The Legend of Zelda 40th Anniversary Edition**
en tiendas chilenas y avisa apenas aparece stock, preventa, cambia el precio o sale una publicación nueva.

Motor: scraping de las tiendas conocidas + JSON-LD, con estado diff-based persistido en GitHub.
Disparador: un **Cloudflare Worker** con cron de 1 minuto que pide a **GitHub Actions** ejecutar el monitor.

```
Cloudflare Cron (cada 1 min)
        │  repository_dispatch: cloudflare_tick
        ▼
GitHub Actions · cloudflare-dispatch.yml
        │  node cloudflare/run-monitor.mjs
        ▼
cloudflare/src/monitor-core.js
        ├── estado  →  state/cloudflare-state.json (API de Contents de GitHub)
        ├── alerta  →  Issue de GitHub (asignado al dueño del repo)
        └── aviso   →  Telegram (opcional)
```

## Qué vigila

- **7 tiendas**: Bestmart, Santo Games, Play Service, Mathogames, TodoJuegos, WePlay, Paris.
- **Mercado Libre · Tienda Oficial Nintendo**: exige que la ficha sea de la tienda oficial (descarta vendedores terceros y juegos sueltos de Zelda).
- **Catálogos** de Falabella, Ripley, Lider y Sniper (cada 2 min).
- **Zona Gamer Iquique** y preorders publicados en redes sociales (cada 5 min).
- **Estuche/funda Zelda 40th** como producto aparte (cada 5 min).
- **Descubrimiento amplio** de tiendas y publicaciones chilenas nuevas vía Bing RSS (cada 15 min).

## Comportamiento clave (leelo antes de confiar en una alerta)

| Regla | Por qué |
|---|---|
| La **primera corrida** solo arma la línea base | No dispara un backlog de avisos el primer día. |
| Un cambio a "disponible" exige **dos lecturas consecutivas** | Evita falsos positivos por una lectura puntual. |
| `error` / `unknown` **nunca** pisan el último estado confiable | Un bloqueo de Cloudflare no es "agotado". |
| Solo se alerta con evidencia accionable | Agotado→disponible, cambio de precio con stock, publicación nueva. |
| Cada alerta incluye el link | Ningún scraper garantiza 100%: confirmá antes de comprar. |

## Estructura

```
cloudflare/
  src/monitor-core.js   motor de monitoreo (tiendas, ML, catálogos, social, estado, Issues, Telegram)
  src/index.js          Worker: cron → repository_dispatch + endpoint /health y /run
  run-monitor.mjs       runner del workflow (escribe el Summary de Actions)
  test/monitor.test.mjs tests offline (sin red) con node:test
  scripts/              configure-owner.mjs
  wrangler.jsonc        cron, vars y secrets del Worker
.github/workflows/
  cloudflare-dispatch.yml  el workflow que ejecuta el monitor
  telegram-*.yml           configuración y prueba del canal de Telegram
state/cloudflare-state.json  línea base del monitor
```

## Requisitos

- Cuenta de GitHub y un repositorio para el monitor.
- Cuenta de Cloudflare (plan gratuito alcanza).
- Node.js 20+.
- Opcional: `gh` CLI para crear el repo desde la terminal.

## Puesta en marcha

### 1. Crear el repositorio

```bash
cd /home/lenovomint/Escritorio/IA/switch2-zelda-stock-cl
git init && git add -A && git commit -m "feat: base del monitor Switch 2 Zelda 40th (Cloudflare Worker)"
gh repo create switch2-zelda-stock-cl --public --source=. --push
```

> **El repo tiene que ser público** (o pagás Actions). El Worker dispara un workflow por minuto:
> 43.200 ejecuciones/mes, muy por encima de los 2.000 min/mes del plan gratuito de repos privados.
> El repo no guarda secretos: solo snapshots de stock.

Si no usás `gh`, crealo desde la web y subí el contenido.

### 2. Configurar la identidad del Worker

```bash
cd cloudflare
npm run configure -- <TU-USUARIO-GITHUB> switch2-zelda-stock-cl
```

Deja `GITHUB_OWNER` y `GITHUB_REPO` en `wrangler.jsonc`.

### 3. Crear el token de GitHub

Un **Fine-grained PAT** con acceso solo a ese repositorio:

- `Contents: Read and write` (guardar el estado y disparar el workflow)
- `Issues: Read and write` (abrir las alertas)

El mismo token sirve para todo. No lo guardes en el repositorio.

### 4. Desplegar el Worker (desde el dashboard de Cloudflare)

En **Workers & Pages → Create → Import from GitHub**:

| Campo | Valor |
|---|---|
| Repositorio | `ricardoaevt/switch2-zelda-stock-cl` (o el tuyo) |
| Root directory | `cloudflare` |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |

Después, dentro del Worker → **Settings → Variables and Secrets**:

| Nombre | Tipo | Valor |
|---|---|---|
| `GITHUB_TOKEN` | **Secret** | tu fine-grained PAT |
| `RUN_TOKEN` | Secret (opcional) | habilita el disparo manual `POST /run` |

El cron queda en `* * * * *` (cada minuto). Verificá que esté vivo:

```bash
curl -s https://switch2-zelda-stock-cl.<tu-subdominio>.workers.dev/health | jq
```

<details>
<summary>Alternativa: desplegar desde la CLI</summary>

```bash
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # pega el PAT
npm run deploy
```

Mismo resultado; el dashboard es la vía recomendada porque no necesita instalar nada en local.
</details>

### 5. Habilitar los workflows y los secretos del repo

En GitHub → **Settings → Secrets and variables → Actions**:

| Nombre | Tipo | Para qué |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | secret (opcional) | Token del bot de Telegram |
| `TELEGRAM_CHAT_ID` | secret (opcional) | Grupo/canal donde avisar |
| `NOTIFY_USER` | variable (opcional) | Segundo usuario a asignar y mencionar en el Issue |

Para Telegram: creá el bot con @BotFather, mandale `/start` desde el grupo y corré el workflow
**Configurar y probar Telegram** para descubrir el `Chat ID` y guardar el secret.

En **Actions** habilitá los workflows del repo (si GitHub no lo hizo solo).

### 6. Verificar una corrida real

1. La primera corrida **solo arma la línea base**: no hay Issue, pero sí un commit de estado.
2. La corrida siguiente tampoco abre Issue si nada cambió.
3. Comprobación manual del pipeline completo, sin esperar un cambio real de stock:

   ```bash
   curl -s -H "Authorization: Bearer <RUN_TOKEN>" \
     https://switch2-zelda-stock-cl.<tu-subdominio>.workers.dev/run
   ```

   Eso dispara el workflow; en **Actions** vas a ver la corrida y el Summary con el estado de cada tienda.

## Tests

Los tests son **offline y deterministas**: simulan `fetch` con fixtures y no tocan la red.

```bash
cd cloudflare
npm test
```

Cubren: línea base sin alertas, confirmación en dos lecturas antes de alertar, página anti-bot que no
pisa el estado confiable, destino de las llamadas a la API de GitHub y el fallo sin `GITHUB_TOKEN`.

## Costos y límites

| Pieza | Costo |
|---|---|
| Cloudflare Workers (cron 1/min) | Gratis dentro del plan gratuito. |
| GitHub Actions | Gratis en repo público. En privado, ~43.200 ejecuciones/mes → excede el plan gratuito. |
| Issues de GitHub | Sin límite práctico para este uso. |

Si el repo es privado, subí el cron del Worker a `*/5 * * * *` en `wrangler.jsonc`.

## Operación y mantenimiento

- **El scraper se rompe si cambia el HTML de una tienda.** Cuando una tienda cambie su diseño, el
  monitor la reporta como `unknown`/`error` y deja de actualizar su estado. Se corrige ajustando
  `cloudflare/src/monitor-core.js` (`inspectStore`, `parseJsonLd`).
- **Perdí el estado**: borrá `state/cloudflare-state.json` y la próxima corrida reconstruye la línea
  base sin generar alertas falsas.
- **Conflictos de push**: el estado se versiona en git; el monitor commitea con `--skip ci`. Si el
  push falla por conflicto, se reintenta con rebase.
- **Probalo de punta a punta** con `npm test` antes de tocar el motor.

## Creditos

Implementación derivada de [`jsantiscl/switch2-zelda-stock-cl`](https://github.com/jsantiscl/switch2-zelda-stock-cl).
