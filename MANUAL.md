# Manual operativo — Monitor Switch 2 · Zelda 40th (Chile)

Este es el manual del sistema: cómo funciona por dentro, qué protocols usa, cuánto cuesta, qué se rompe y
qué hacer cuando se rompe. El [README](README.md) queda como guía de instalación; este documento explica
**por qué** cada pieza existe y **cómo operarla**.

> **Estado actual:** en producción. Repo público `ricardoaevt/switch2-zelda-stock-cl`, Cloudflare Worker
> con cron de 1 minuto, ~1.440 corridas por día, 0 USD de costo.

---

## 0. Instalación desde cero (checklist)

Para replicar esta solución completa, en este orden:

**A. Cuentas y credenciales**
- [ ] GitHub: una cuenta con un repo **público** (el público es lo que hace gratuit Actions).
- [ ] GitHub → *Settings → Developer settings → Fine-grained tokens → New*:
      - Repository access: *Only select repositories* → el repo del monitor.
      - Repository permissions: `Contents: Read and write` · `Issues: Read and write`.
      - El mismo token lo usan **el Worker** (secret `GITHUB_TOKEN`) y **Actions** (el `GITHUB_TOKEN` automático del repo ya sirve).
- [ ] Cloudflare: una cuenta (plan gratuito alcanza) con permisos para crear Workers.
- [ ] Telegram (opcional pero recomendado): @BotFather → `/newbot` → token.

**B. Repo**
```bash
gh repo create <nombre> --public --source=. --push
```
El repo debe quedar con: `cloudflare/` (motor, worker, runner, tests), `.github/workflows/`, `state/` y `README.md` + `MANUAL.md`.

**C. Identidad**
```bash
cd cloudflare && npm install
npm run configure -- <TU-USUARIO-GITHUB> <nombre-del-repo>   # deja GITHUB_OWNER/GITHUB_REPO en wrangler.jsonc
```

**D. Worker (dashboard)**
- [ ] Workers & Pages → **Create** → **Import from GitHub** → el repo.
- [ ] Root directory `cloudflare` · Build command `npm install` · Deploy command `npx wrangler deploy`.
- [ ] Deploy.
- [ ] En el Worker → *Settings → Variables and Secrets* → **`GITHUB_TOKEN`** (tipo *Secret*) = el PAT del punto A.
- [ ] Opcional: `RUN_TOKEN` (secret) para el disparo manual por HTTP.

**E. Telegram (opcional)**
- [ ] `gh secret set TELEGRAM_BOT_TOKEN` (el token de @BotFather).
- [ ] Agregar el bot al grupo destino.
- [ ] `gh workflow run telegram-setup.yml` → leer el **Chat ID** en el Summary.
- [ ] `gh secret set TELEGRAM_CHAT_ID` con ese número.
- [ ] `gh workflow run telegram-tools.yml -f action=enviar_prueba` → debe llegar el mensaje.

**F. Primera corrida**
- [ ] El cron dispara a los 60 s: en *Actions* aparece `🤖 Cloudflare → GitHub`.
- [ ] La **primera** corrida solo arma la línea base (0 alertas) y el bot commitea el estado.
- [ ] Verificar: `curl -s https://<worker>.workers.dev/health` → `"ok": true` y `"github_token_configured": true`.

**G. Rotar credenciales expuestas**
- [ ] Si el token del bot quedó en un chat o log: @BotFather → `/revoke` → actualizar el secret del repo.

---

## Ruta rápida

Si algo no funciona, este es el orden de verificación:

1. ¿Llegó la señal de Cloudflare? → `gh run list -L 5` (¿hay corridas `repository_dispatch`?)
2. ¿El Worker tiene credenciales? → `curl -s https://<worker>.workers.dev/health`
3. ¿El monitor leyó las tiendas? → pestaña **Actions → última corrida → Summary**
4. ¿Hubo alerta? → `gh issue list` y el grupo de Telegram
5. ¿El estado se persistió? → `state/cloudflare-state.json` en el repo (lo commitea el bot)

---

## 1. El modelo mental

### 1.1 Las cuatro piezas

| Pieza | Dónde vive | Qué hace | Es desechable |
|---|---|---|---|
| **Cloudflare Worker** (`cloudflare/src/index.js`) | Bundle de 4,27 KiB en el edge de Cloudflare | Envía un POST a GitHub cada minuto | Sí: cada invocación es una instancia nueva |
| **GitHub Actions** (`cloudflare-dispatch.yml`) | Runner efímero `ubuntu-latest` | Baja el motor, scrapea, guarda estado, avisa | Sí: una VM que se levanta y se destruye |
| **Estado** (`state/cloudflare-state.json`) | Tu repo, vía API de Contents | Recuerda el último snapshot por tienda | No: es lo único que recuerda algo |
| **Alertas** | Issue de GitHub + Telegram | Te avisan | No: es la salida |

### 1.2 El Worker es un programita, y el cron es otra cosa

Confusión habitual: *"Cloudflare es solo un cron"*. No: un **Worker es código** (`src/index.js`), y
`wrangler.jsonc → triggers.crons` es **cuándo** se ejecuta ese código. Son dos configuración distintas.

```
00:00  push a main   → Cloudflare compila index.js → sube 4 KB a su edge   ← el "compilando" del dashboard
00:01  llega la alarma → Cloudflare ejecuta los 4 KB ya subidos → POST a GitHub → la instancia muere
00:02  llega la alarma → instancia nueva → POST a GitHub → muere
```

Compilar ocurre **una vez por push**. Cada minuto no se compila nada: se ejecuta un archivo que ya estaba
subido. Por eso el bundle es de 4 KB: `index.js` **no** incluye el motor de scraping.

### 1.3 Por qué el trabajo pesado está en GitHub y no en Cloudflare

| Razón | Detalle |
|---|---|
| **Límite de CPU** | Workers Free da **10 ms de CPU por invocación**. El scraping tarda segundos: no entra. |
| **No hay dónde guardar el estado** | El monitor necesita recordar qué vio la vez pasada. El Worker es efímero; tu repo es el único almacenamiento. |
| **Anti-bots** | Las tiendas bloquean por IP. Desde el edge de Cloudflare la respuesta puede ser distinta que desde tu homelab. |

Por eso el reparto: **Cloudflare pone el reloj (caro de mantener 24/7), GitHub pone la máquina y la memoria.**

### 1.4 Por qué el estado vive en un archivo del repo

| Necesidad | Cómo la resuelve el archivo en git |
|---|---|
| Recordar el último snapshot | `state/cloudflare-state.json` |
| Versionado y diff | Cada cambio es un commit: `chore: actualizar estado Cloudflare monitor [skip ci]` |
| Rollback | `git revert` de un commit de estado |
| Sin base de datos | Nada que mantener, nada que costar |
| Escritura | `PUT` a la API de Contents = un commit. Requiere `Contents: Read and write` |

---

## 2. Los protocolos: cómo se hablan las piezas

### 2.1 `repository_dispatch` — el timbre (el que usa Cloudflare)

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ricardoaevt/switch2-zelda-stock-cl/dispatches \
  -d '{"event_type":"cloudflare_tick","client_payload":{"scheduled_time":"2026-11-15T13:40:00Z"}}'
# → HTTP 204 (sin cuerpo) = el workflow despertó
```

La credencial es un **fine-grained PAT** con `Contents: Read and write` sobre ese repo. El mismo token
sirve para el Worker y para el estado.

### 2.2 `workflow_dispatch` — el botón manual

Botón *Run workflow* en la pestaña Actions, o:

```bash
gh workflow run cloudflare-dispatch.yml -R ricardoaevt/switch2-zelda-stock-cl
```

Útil para probar sin esperar al cron.

### 2.3 `POST /run` — el timbre del Worker (opcional)

```bash
curl -X POST -H "Authorization: Bearer $RUN_TOKEN" https://<worker>.workers.dev/run
```

Requiere el secret `RUN_TOKEN` en el Worker. **No es necesario**: el cron dispara solo.

### 2.4 Quién puede tocar el timbre

El trigger está desacoplado de la ejecución: **quien llama es indistinto**. Desde el homelab:

```bash
# systemd timer en el host (lo más simple)
ExecStart=/usr/bin/curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ricardoaevt/switch2-zelda-stock-cl/dispatches \
  -d '{"event_type":"cloudflare_tick"}'
```

También sirve un contenedor con `supercronic` u `ofelia` (stack de Portainer o compose de Dokploy), con
el PAT como variable de entorno del stack — nunca en la imagen ni en el repo.

### 2.5 Reglas del timbre

| Regla | Detalle |
|---|---|
| **Un solo dispatcher** | Cloudflare **o** homelab, no ambos. Los dos escribiendo el estado en el mismo segundo ⇒ el segundo recibe **409 (sha desactualizado)** y esa corrida muere. |
| **≤ 20 ejecuciones/minuto** | Límite de GitHub Actions. 1/min o 2/min van sobrado. |
| **≤ 5.000 req/hora** | Rate limit de la API de GitHub por token autenticado. |
| **El token no se loguea** | Va en header, nunca en logs del contenedor ni en `systemctl status`. En Dokploy/Portainer: secret/env var. |

---

## 3. Anatomy del workflow

```yaml
on:
  repository_dispatch:        # ← evento externo (el Worker o el homelab)
    types: [cloudflare_tick]  # ← el nombre exacto; si cambia, el timbre deja de encontrar el workflow
  workflow_dispatch:          # ← además, botón manual

permissions:
  contents: write             # ← commitear el estado
  issues: write               # ← abrir las alertas

concurrency:
  group: switch2-zelda-monitor   # ← una corrida a la vez; la otra espera (no se cancela)
  cancel-in-progress: false
```

Los tres pasos del job:

1. **Descargar** `run-monitor.mjs` y `monitor-core.js` desde `raw.githubusercontent.com/{repo}/{sha}`.
   No usa `actions/checkout`: baja *exactamente* la versión que pidió el timbre, no "lo que haya ahora".
2. **`node --check`** de ambos: si hay error de sintaxis, corta ahí sin gastar minutos.
3. **Ejecutar** `node cloudflare/run-monitor.mjs` con `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `SCHEDULED_TIME`.

### 3.1 Por qué no hay cron de GitHub

| | Cron de GitHub | Cron de Cloudflare |
|---|---|---|
| Frecuencia mínima | 5 minutos | **1 minuto** |
| Costo | 2.000 min/mes gratis (repo privado) | Gratis, 100.000 requests/día |
| Fiabilidad | **GitHub los ignora si el repo lleva 60 días sin actividad** | Sin ese criterio |
| Exige | repo público para no pagar | nada del repo |

Por eso el upstream no usa el cron de GitHub en esta ruta. Los workflows `monitor.yml` / `auto-monitor.yml`
del upstream (variante Python, marcada *legacy*) sí lo usaban: no se copiaron.

### 3.2 Cambiar la cadencia

Se toca **un solo lugar**: `cloudflare/wrangler.jsonc → triggers.crons`.

```jsonc
"crons": ["* * * * *"]     // cada minuto
"crons": ["*/2 * * * *"]   // cada 2 minutos
```

- **No basta con editar el archivo**: el cron se registra en el deploy. Con *Import from GitHub*, cada push
  a `main` dispara build + deploy → el cron nuevo queda activo. Hasta que el build termine, sigue corriendo
  la versión anterior (1-2 min de solapamiento: normal).
- Si el build **falla**, el Worker viejo sigue vivo: falla de forma segura.
- Editarlo desde el dashboard (*Triggers*) aplica al instante, pero **queda pisado** en el próximo deploy
  desde el repo → la fuente de verdad es el repo.
- Con `*/2` la cadencia interna del motor se conserva (`minute % 15`, `% 5`, `% 2` siguen cayendo en
  minutos pares). Con `*/3`, la búsqueda amplia pasaría a cada 30 minutos.
- **Ojo:** el endpoint `/health` tiene el cron **escrito a mano** (`"* * * * *"`). Miente si cambiás la
  cadencia. La verificación real es la separación temporal de `gh run list`.

---

## 4. Anatomy del monitor: las reglas de confianza

Un monitor que miente es peor que uno que no existe. Estas reglas existen para que **no** te avise de
basura:

| Regla | Qué evita |
|---|---|
| **Línea base** en la primera corrida | 300 avisos el primer día por productos agotados hace semanas |
| **Dos lecturas consecutivas** para alertar | Un re-render que muestra "disponible" un segundo y lo saca |
| **`error` / `unknown` no pisan el estado** | Un 403 de Cloudflare se lee como "agotado" ⇒ alerta falsa |
| **Filtro de precio 500.000–2.000.000 CLP** | Que tome el precio de un juego o un cable como si fuera el de la consola |
| **JSON-LD antes que texto** | El texto de la página trae precios de productos relacionados |
| **Solo evidencia accionable** | Nada de "cambió el título": solo stock/preventa, precio y publicación nueva |

### 4.1 `unavailable` vs `error`: la distinción que más importa

| Estado | Significado | ¿Alerta? | ¿Pisa el estado? |
|---|---|---|---|
| `available` | Disponible / preventa comprable | Sí, si es transición | Sí |
| `unavailable` | Agotado, dato confiable | Sí, si es transición | Sí |
| `page_missing` | 404: la ficha no existe | No | Sí |
| `unknown` | Se leyó la página pero no se pudo concluir | No | **No** |
| `error` | Bloqueo anti-bot, 5xx, timeout | No | **No** |

### 4.2 Conocido vs descubrimiento: una diferencia que muerde

El motor tiene dos caminos de alerta, y **no se comportan igual**:

| Camino | Dispara alerta si… |
|---|---|
| **Tienda descubierta** (nueva URL) | aparece y está `available` |
| **Tienda de la lista fija** (`STORES`) | hay **transición** desde un snapshot previo (`unavailable → available`) |

Consecuencia real, medida en producción: **Paris figura `available` a $719.990 y no abrió ningún Issue**,
porque en sus primeras lecturas falló (no quedó snapshot previo) y su primer acierto creó la línea base
**en silencio**. Como "disponible → disponible" no es transición, ese estado no vuelve a generar alerta.

> **Pendiente conocido.** Tratar *"sin snapshot previo + `available`"* como evento alertable también para
> las tiendas de la lista fija. Con ese cambio, Paris y la URL vigente de Mathogames avisan apenas el
> monitor los ve. Es un cambio pequeño en `cloudflare/src/monitor-core.js` + un test en
> `cloudflare/test/monitor.test.mjs`.

---

## 5. Operación

### 5.1 Checklist

- [ ] ¿Hay corridas `repository_dispatch` reciente? → `gh run list -L 5`
- [ ] ¿El Worker tiene el token? → `curl -s https://<worker>.workers.dev/health` → `"github_token_configured": true`
- [ ] ¿El monitor leyó las tiendas? → **Actions → última corrida → Summary**
- [ ] ¿El estado se persistió? → `state/cloudflare-state.json` con `"initialized": true`
- [ ] ¿La alerta salió? → `gh issue list` + grupo de Telegram
- [ ] ¿Las notificaciones de GitHub están activas? → *Settings → Notifications → "Issues asignados a vos"*

### 5.2 Cómo leer el Summary de una corrida

```
| Tienda | Estado | Precio | HTTP |
|---|---|---:|---:|
| Paris | 🟢 Disponible / preventa | $729.990 | 200 |

- Lecturas fiables: 5 de 7
- Bloqueadas/no concluyentes: 2
- Descubrimiento amplio: no corresponde (corre cada 15 min)
```

`Bloqueadas/no concluyentes` alto y sostenido = alguna tienda cambió su HTML o está bloqueando. Es la
señal para ir a mantenimiento.

### 5.3 El estado, campo por campo

```jsonc
{
  "version": 1,
  "initialized": true,          // ¿ya se construyó la línea base?
  "stores": {                   // snapshot por URL conocida
    "<url>": {
      "name": "Paris",
      "snapshot": { "http": 200, "status": "available", "price_clp": 719990, "title": "…" },
      "last_changed_at": "2026-11-15T13:38:53.900Z"
    }
  },
  "discovered": {},             // URLs nuevas encontradas por la búsqueda amplia
  "retailer_discovered": {},    // fichas nuevas en catálogos de retailer
  "zelda40_case_discovered": {},// estuches Zelda 40th
  "pending_available": {}       // disponibilidad a la espera de 2ª lectura
}
```

`pending_available` con entradas = hay disponibilidad sin confirmar todavía. Es normal que se llene y se
vacíe.

### 5.4 Mantenimiento

| Situación | Qué hacer |
|---|---|
| Una tienda cambia su HTML | Queda en `unknown`/`error` y deja de actualizar su estado. Se corrige en `inspectStore` / `parseJsonLd` (`cloudflare/src/monitor-core.js`). |
| Se perdió el estado | Borrá `state/cloudflare-state.json`: la próxima corrida reconstruye la línea base **sin** alertas falsas. |
| Conflicto de escritura (409) | Dos dispatchers escribiendo a la vez. Dejá uno solo (§2.5). |
| El motor cambió | Push → la próxima corrida ya lo usa (no requiere redesplegar Cloudflare: el motor se baja en runtime). `index.js` sí requiere redeploy. |
| `state/cloudflare-state.json` | **Es del bot**: lo escribe cada 1-2 minutos. Un commit humano que lo toque choca con el rebase. Para corregirlo, hacelo en una corrida del bot, no en un commit |
| `index.js` cambió | Push → Cloudflare rebuilds y redespliega (build-on-push). |

---

## 6. Costos y límites

| Pieza | Plan | Límite | Consumo real |
|---|---|---|---|
| Cloudflare Workers | $0 | 100.000 req/día · **10 ms CPU**/invocación · 5 cron triggers · mínimo 1 min | 1.440 invocaciones/día → **1,4%** |
| GitHub Actions | $0 (repo público) | Minutos **ilimitados** con runners estándar | ~1.440 corridas/día × ~20 s |
| API de GitHub | $0 | 5.000 req/h por token | ~4/min en el pico |
| Issues + Telegram | $0 | — | — |

### 6.1 Dónde se rompe el "gratis"

1. **Si el repo pasa a privado**: hacen falta ~14.400 min/mes (1.440 corridas × 20 s) contra 2.000
   incluidos → **~US$115/mes**. La visibilidad pública no es cosmética, es la diferencia entre $0 y $115.
2. **Cloudflare Workers Paid cuesta US$5/mes mínimo**, solo si te pasás de los límites gratis.
3. **El cron no puede bajar de 1 minuto.**
4. **10 ms de CPU es el límite más apretado** del diseño: por eso el parseo vive en Actions y no en el
   Worker. Meter scraping en el Worker rompe el diseño en silencio.
5. **Observability con retención histórica es de pago.** El tail de logs en vivo es gratis.
6. **20 ejecuciones concurrentes/minuto** es el tope de Actions.

### 6.2 La métrica que importa

Cada corrida cuesta ~20 s de runner y 0 USD. Lo que sí se desgasta es el **ruido**: el bot commitea el
estado **solo cuando cambia** (medido: 4 commits de estado en 12 corridas). Si commiteara siempre, serían
1.440 commits/día.

---

## 7. Fuentes vigiladas y su estado real

| Fuente | Estado medido (2026-11-15) | HTTP | Nota |
|---|---|---|---|
| Bestmart | `page_missing` | **404** | La ficha **ya no existe** (ni el suggest API de Shopify la lista). Queda como watchdog: si vuelve, salta. |
| Santo Games | `unavailable` | 200 | $699.990 |
| Play Service | `unavailable` | 200 | Sin precio legible |
| Mathogames | `page_missing` | **404** | URL vieja (`2538-...`). La vigente es `2576-preventa-...-singapur-version.html` (200, `available`). **Pendiente de corregir.** |
| TodoJuegos | `unavailable` | 200 | $669.900 |
| WePlay | `skipped` | **403** | Anti-bot. Queda sin lectura (desde CF y desde el homelab). |
| Paris | `available` | 200 | **$719.990** — ver §4.2: disponible pero sin alerta. |
| Mercado Libre · Tienda Oficial | `not_found` | 200 | Sin publicación de la consola ahora mismo. |
| Falabella / Lider / Sniper (catálogos) | `not_found` | 200 | Sin ficha de la consola. |
| Ripley (catálogo) | `http_403` | 403 | Anti-bot. |
| Zona Gamer Iquique | `not_checked` | — | **Fuente caída**: Facebook devuelve 400 y el mirror no resuelve. La búsqueda social no aporta. |
| Estuche Zelda 40th | `not_checked` | — | Corre cada 5 min; sin resultados. |

---

### 7.1 Auditoría del 15/11 y ajustes aplicados

La auditoría de fuentes (URLs consultadas, HTTP real y contenido de cada página) encontró que
varias fuentes no podían funcionar y que **Falabella tenía la consola disponible y el monitor no la veía**:

| Hallazgo | Ajuste |
|---|---|
| **Bestmart** 404: la consola Zelda 40 ya no está en su catálogo (el suggest API de Shopify no la lista) | **Sacar de `STORES`**. Si vuelve, el descubrimiento por Bing RSS recupera la URL |
| **WePlay** 403 en las dos URLs (anti-bot): ilegible desde CI | **Sacar de `STORES`** |
| **Mathogames** con la URL vieja (404) | Ya corregido a la ficha vigente `2576` |
| **Imperio Gamers** (Puerto Montt) con preventa verificada, repone por importación | **Añadida a `STORES`** |
| **Falabella**: la consola estaba en la colección ($819.990, "agregar al carro", entrega mañana) y el monitor no la veía | El escaneo de catálogos ahora lee el **JSON embebido** de la página (Falabella no expone la ficha en un `<a href>`) y toma precio y disponibilidad del bloque visible del producto |
| **`PURCHASE_SIGNALS` no incluía "agregar al carro"** (el texto que usa Falabella; el motor solo conocía "agregar al carrito") | **Corregido**: "agregar al carro", "añadir al carro" y "anadir al carro" ahora cuentan como señal de compra |
| **Ripley** 403, **Lider** 14 KB (render por JS) y **Sniper** sin la consola | **Fuera de la lista de catálogos**: solo queda Falabella |
| **Zona Gamer Iquique**: la página de Facebook responde 400 y el espejo público no resuelve | Las dos fuentes directas se retiran; queda solo el **respaldo por búsqueda web** (cada 15 min) |
| El escaneo de catálogos tomaba **6 productos** en vez de 1 (la ventana de contexto de cada URL incluía el JSON completo de la colección) | Cada URL se empareja con **su propio nombre** en el JSON: solo entran las fichas que son la consola |
| El precio de la consola en Falabella salía **$559.990** (el mínimo de la página, de otro producto) | El precio se lee del **propio ítem en el JSON** ($819.990) y cada producto se empareja con el bloque visible que más tokens distintivos comparte con su nombre |

**Sobre Paris (marketplace):** la ficha dice "vendido por Paris" y el botón "comprar ahora" está
presente de forma estable (10 de 10 lecturas en 40 s), pero el stock depende del vendedor: el sitio
puede alternar entre "con stock" y "sin stock" en minutos. El monitor interpreta el botón como
disponibilidad, así que **es la fuente con más riesgo de falso positivo** del conjunto.

### 7.2 El buscador de cada tienda (red propia, sin depender de Bing)

El núcleo del monitor son **URLs fijas**: si una tienda mueve la ficha de la consola a otra URL, el
monitor deja de verla ahí. Como red de contención existe el **buscador de cada tienda** (`STORE_SEARCH_PAGES`),
que corre **cada 5 minutos** y no depende del índice de Bing (que va con horas o días de retraso):

| Tienda | Buscador | Estado |
|---|---|---|
| Bestmart | `/search/suggest.json` (API de Shopify) | responde; hoy 0 candidatos (la consola ya no está en su catálogo) |
| Falabella | `/falabella-cl/search?Ntt=zelda+40` | **2 fichas**: consola $819.990 y bundle con Ocarina of Time $899.990 |
| Paris | `/paris.cl/search?q=zelda+40` | responde; hoy 0 candidatos extraíbles |
| Mathogames | `/115-switch-2` (categoría) | **1 ficha**: preventa $749.990 |
| Santo Games | `/santogames.cl/search?q=zelda` | responde; hoy 0 candidatos extraíbles |
| Play Service | `/?s=zelda&post_type=product` | responde; hoy 0 candidatos extraíbles |

**Filtros de seguridad** (para que no repita los falsos positivos del escaneo de catálogos):
una ficha entra solo si (a) su título menciona Switch 2 + Zelda + 40º, (b) su precio cae en la banda de
la consola ($500.000–$2.000.000) y (c) el precio es **de ese producto** (el del JSON de su propio ítem
o el de su tarjeta), nunca el mínimo de la página. Así el estuche de $64.990 y el pro controller de
$169.990 quedan fuera.

TodoJuegos no expone un buscador legible (404) y la consola de Imperio Gamers no dice "40" en el título
(ya está vigilada por su URL fija).

## 8. Troubleshooting

| Síntoma | Causa probable | Dónde mirar |
|---|---|---|
| No hay corridas en Actions | El cron no está habilitado / el Worker no dispara | CF → Triggers; `curl /health` |
| `/health` → `"github_token_configured": false` | El secret no se cargó o está mal pegado | CF → Settings → Variables and Secrets |
| `GitHub repository_dispatch failed: 401` | El PAT no tiene `Contents: Read and write` | Permisos del fine-grained token |
| `GitHub repository_dispatch failed: 403` | El PAT no alcanza ese repo | Alcance del token |
| Corridas fallan con 409 al guardar el estado | Dos dispatchers a la vez | §2.5 |
| Nunca hay alertas, pero el estado se actualiza | La consola está agotada, **o** las URLs cambiaron (§7) | El Summary de la corrida |
| Una tienda siempre en `unknown` | Cambió su HTML | `inspectStore` / `parseJsonLd` |
| Una tienda siempre `error` | Anti-bot | No es bug: se ignora sola |
| Telegram mudo pero hay Issue | Faltan `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` en el repo | Logs: `TELEGRAM SKIPPED` |
| No te avisa ningún Issue | Notificaciones de GitHub desactivadas | Settings → Notifications |
| El bot no commitea el estado | No hubo cambios (normal) | `dirty` flag |

---

## 9. Configurar Telegram (una vez)

1. **@BotFather** → `/newbot` → token = `TELEGRAM_BOT_TOKEN`.
2. Agregar el bot al grupo y enviar `/start@TuBot` en el grupo (obligatorio: con *privacy mode* el bot no
   ve los mensajes normales).
3. `gh secret set TELEGRAM_BOT_TOKEN`
4. `gh workflow run telegram-setup.yml` → leer el **Summary**: lista los chats y sus IDs.
5. `gh secret set TELEGRAM_CHAT_ID` (el número, ej. `-1001234567890`).
6. `gh workflow run telegram-setup.yml` de nuevo → ahora manda un mensaje de prueba.

Los secrets van en el **repo** (Settings → Secrets and variables → Actions), no en el Worker: quien manda
el mensaje es el runner de Actions. Si falta el secret, el monitor **no se rompe**: loguea
`TELEGRAM SKIPPED` y el Issue de GitHub se abre igual.

---

## 10. Glosario

| Término | Significado en este proyecto |
|---|---|
| **Worker** | Programita que Cloudflare ejecuta en su edge. Acá: el que llama a GitHub. |
| **Cron Trigger** | La alarma que le dice al Worker cuándo ejecutarse. |
| **Build / deploy** | El paso en que Cloudflare empaqueta `index.js` y lo sube a su edge. Ocurre en cada push. |
| **repository_dispatch** | Evento externo que despierta un workflow. El "timbre". |
| **workflow_dispatch** | Evento que dispara el botón "Run workflow". |
| **Runner** | La máquina efímera donde GitHub ejecuta el workflow. |
| **Snapshot** | El estado de una tienda en una lectura: status, precio, HTTP, título. |
| **Línea base** | La primera corrida: guarda estado sin generar alertas. |
| **Estado** | `state/cloudflare-state.json`: la memoria del monitor. |
| **Alerta accionable** | Solo cambios con evidencia: stock/preventa, precio, publicación nueva. |

---

## 11. Decisiones de diseño (y por qué)

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Cron de Cloudflare + Actions | Cron de GitHub | 1 min en vez de 5; gratis; no se desactiva por inactividad |
| Repo **público** | Repo privado | Actions ilimitados vs ~US$115/mes |
| Estado en un archivo de git | Base de datos | Sin infraestructura, versionado, rollback gratis |
| Alertas por Issue + Telegram | Solo Telegram | Issue = historial consultable + notificación nativa de GitHub |
| Motor en JS, no Python | El scraper Python del upstream | El JS cubre catálogos, Zona Gamer, redes, estuches y Telegram |

**Créditos:** implementación derivada de
[`jsantiscl/switch2-zelda-stock-cl`](https://github.com/jsantiscl/switch2-zelda-stock-cl).

## 12. Adaptar el monitor a otro producto

La **arquitectura es agnóstica**: Worker + cron + dispatch + estado en git + alertas por Issue/Telegram
sirven para cualquier producto. Lo que cambia es **qué se busca**. Esta es la lista completa de lo que
hay que tocar, con el archivo y la constante donde vive cada cosa:

| Qué | Dónde | Qué cambiar |
|---|---|---|
| **Tokens que identifican la ficha** | `target40Nearby()` en `cloudflare/src/monitor-core.js` | Hoy exige `switch 2` + `zelda` + `40/40th/40º` (o la variante `edición Zelda` + `preventa` + `consola`). Para otro producto, reescribir esos patrones — es **el** punto que más conviene generalizar |
| **Variante laxa** | `mentionsTargetConsole()` | Usa `switch 2` + `zelda` + `40`. Se usa para las fichas embebidas en JSON. Cambiar los tokens acá también |
| **Banda de precio** | `money()` (por defecto `500000..2000000`), `CONSOLE_PRICE_MIN`/`CONSOLE_PRICE_MAX` | La banda evita confundir la consola con juegos y accesorios. Para otro producto, recalcularla con precios reales |
| **Señales de compra / agotado** | `PURCHASE_SIGNALS`, `NEGATIVE` | Learned the hard way: Chile usa **"agregar al carro"** y **"agregar al carrito"**. Revisar las dos variantes locales |
| **Fichas fijas** | `STORES` | Un objeto por tienda: `{ name, url }` con la URL **de producto** (no de categoría) |
| **Buscadores por tienda** | `STORE_SEARCH_PAGES` | `{ name, kind, url }` con `kind` = `html` o `shopify_json` |
| **Catálogos de retailer** | `RETAILER_WATCH_PAGES` | `{ name, url }` de la página que lista el producto |
| **Consultas de descubrimiento web** | `discoverNewStores()` (18 queries) | Reescribir con los términos del nuevo producto; el filtro `.cl` y las reglas de aceptación se mantienen |
| **Dominios de marketplace** | `ML_STORE_URL` y el bloque de Mercado Libre en `runMonitor` | Si el producto aparece en marketplaces con su propia tienda oficial |
| **Texto de las alertas** | `describe()` en `monitor-core.js` y los títulos del Issue | Hoy dicen "STOCK / PREVENTA DISPONIBLE" y "Nueva publicación" |
| **Estado** | `state/cloudflare-state.json` | Al cambiar de producto, **empezar de cero**: borrar el archivo → la próxima corrida reconstruye la línea base sin alertas falsas |
| **Identidad del Worker** | `wrangler.jsonc` (`name`, `vars`) y el nombre del repo | `npm run configure -- <owner> <repo>` |
| **Tests** | `cloudflare/test/monitor.test.mjs` | Los fixtures usan el producto actual (URL de Mathogames, id de Falabella `159555264`, rutas `/333/`). Hay que reescribirlos con el nuevo producto **y volver a verlos fallar (RED) antes de implementar** |

### Lo que NO hay que tocar

La cadena de disparo (`index.js` → `repository_dispatch` → `cloudflare-dispatch.yml` → `run-monitor.mjs`),
el formato del estado, la lógica de confirmación (dos lecturas), el manejo de `error`/`unknown` y los
canales de alerta (Issue + Telegram) **son los mismos** para cualquier producto.

### Receta de alto nivel

1. Definí el producto: **nombre exacto** como aparece en las tiendas, **variantes** de escritura
   ("40th" / "40.º" / "40 aniversario" / "edición Zelda"), **banda de precio** y **señales de stock**.
2. Armá la lista de fichas: buscá cada tienda, verificá la URL con un request real (200 + el texto del
   producto) y anotá si el precio se lee del JSON-LD, de un JSON embebido o del texto.
3. Escribí los tests con el producto nuevo (RED), implementá (GREEN), corré la suite.
4. Desplegá y dejá correr una hora mirando el Summary: lo que aparece en `unknown` o `error` es lo que
   falta ajustar.

## 13. Recetas de mantenimiento

### Agregar una tienda fija
```js
// cloudflare/src/monitor-core.js → STORES
{
  name: "Mi Tienda",
  url: "https://mitienda.cl/producto/consola-switch-2-zelda-40",
},
```
Antes de agregarla, verificá con un `curl` que la URL responde **200** y que el texto trae el nombre del
producto. Si el precio no se lee, el motor lo dejará en `null` (no es fatal: avisa igual).

### Agregar un retailer al escaneo de catálogos
```js
// RETAILER_WATCH_PAGES
{ name: "Mi Retailer", url: "https://mi-retailer.cl/collection/nintendo-switch-2" },
```
El extractor ya lee la ficha si está en un `<a href>` **o** en un JSON embebido con `name`/`url`/`price`.
Si el retailer expone el producto de otra forma, hay que extender `catalogProductCandidates()`.

### Agregar el buscador de una tienda
```js
// STORE_SEARCH_PAGES
{ name: "Mi Tienda", kind: "html", url: "https://mitienda.cl/search?q=zelda+40" },
```
`kind: "shopify_json"` para tiendas Shopify (devuelve `resources.results.products[]`).

### Cambiar la banda de precio
`money()` (por defecto $500.000–$2.000.000) y `CONSOLE_PRICE_MIN`/`CONSOLE_PRICE_MAX` (banda de las fichas
embebidas). **Ojo**: `money()` filtra por banda, así que para *parsear* un precio suelto hay que llamar
`money(v, 0, Number.MAX_SAFE_INTEGER)` y filtrar aparte.

### Cambiar la ventana de confirmación
En `runMonitor`, el `if (count < 2) continue;` exige dos lecturas. Con `count < 3` serían tres.

### Reiniciar el estado
Borrar `state/cloudflare-state.json` → la próxima corrida reconstruye la línea base **sin** generar
alertas. **No lo commitees a mano**: el bot escribe ese archivo cada 1-2 minutos y el rebase choca.

### Cambiar la cadencia
`cloudflare/wrangler.jsonc` → `triggers.crons` → `"*/2 * * * *"` (2 minutos) y hacer push (Cloudflare
reconstruye y re-registra el cron). Recordar: con `*/3` la búsqueda amplia pasa a cada 30 minutos,
porque su cadencia interna depende del minuto del reloj.

### Cambiar el canal de alertas
- **Issue**: se abre en el repo del monitor y se asigna a `GITHUB_OWNER` (o a `NOTIFY_USER`, variable del repo).
- **Telegram**: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` como secrets **del repo** (no del Worker:
  quien manda el mensaje es el runner de Actions). El id del grupo se obtiene del evento
  `my_chat_member` al agregar el bot.
