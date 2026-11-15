# Monitor Switch 2 Zelda 40th — implementación Cloudflare Worker

Implementar en este repositorio el monitor de stock de la consola *Nintendo Switch 2 – The Legend of Zelda 40th Anniversary Edition* en Chile, usando la ruta de Cloudflare Worker (cron de 1 minuto) que despacha a GitHub Actions, abre Issues de alerta y notifica por Telegram.

## Specs

- **S1** — "vamos a implementar esto https://github.com/jsantiscl/switch2-zelda-stock-cl entiendelo y dame un paso a paso"
- **S2** — Decisión del humano: "1. ¿Qué ruta de ejecución querés implementar? — Cloudflare Worker (completa)"
- **S3** — Decisión del humano: "2. ¿Dónde creo el proyecto en disco? — …/IA/switch2-zelda-stock-cl"
- **S4** — La ruta activa del upstream es Cloudflare Worker → `repository_dispatch` → GitHub Actions → `cloudflare/run-monitor.mjs` → `cloudflare/src/monitor-core.js`. Los archivos Python (`scraper.py`, `monitor.py`) son la variante legacy y no forman parte de esta implementación.
- **S5** — El motor de upstream se conserva íntegro (es el que cubre tiendas, Mercado Libre Tienda Oficial Nintendo, catálogos de retailer, Zona Gamer Iquique, redes sociales, estuche Zelda 40th y confirmaciones de disponibilidad).
- **S6** — Adaptación obligatoria de identidad: ningún archivo puede conservar el owner, repo ni usuario de notificación del upstream (`jsantiscl`, `Baaaaar1`).
- **S7** — El estado arranca en línea base propia (`initialized: false`), sin heredar el estado real del upstream.
- **S8** — Verificación offline determinista del monitor: línea base sin alertas, transición agotado→disponible con alerta, y página anti-bot que no pisa el último estado confiable ni genera alerta.
- **S9** — Documentación de puesta en marcha en español: repositorio GitHub, PAT fine-grained, secrets del Worker, deploy, verificación de una corrida real.
- **S10** — Riesgo operativo conocido: GitHub Actions cobra minutos en repositorios privados; el dispatch de 1 minuto requiere repositorio público para no agotar la cuota.
- **S11** — "en el repo deja el manual de todo lo aprendido y de como fucniona si es que ya no lo hay. a lo mejor el readme lo decia claramente yyo no lo lei. de no ser asi crea el manual" — el README existente cubría instalación pero no el modelo mental, los protocolos, los límites reales ni los hallazgos; el manual se crea aparte y el README lo enlaza.

## Tasks

| ID | Specs | Route | Commit |
|---|---|---|---|
| T1 | S4, S5 | inline — copiar motor, dispatcher, runner, workflows y estado desde upstream | `ffb9a79` |
| T2 | S6, S7 | inline — parametrizar owner/repo/usuario notificado y reiniciar la línea base | `ffb9a79` |
| T3 | S8 | inline — tests offline con `node:test` sobre `runMonitor` con `fetch` simulado | `00d6fd5` |
| T4 | S9, S10 | inline — README de puesta en marcha + scripts de configuración y deploy | `5586f40` |
| T5 | S8, S9 | inline — verificación final (tests + `node --check`) y commit inicial | `5586f40` |
| T6 | S9, S10 | inline — desplegar el Worker (import desde dashboard), documentar la vía dashboard y verificar el circuito en vivo | `f9d7684` |
| T7 | S11 | inline — escribir `MANUAL.md` (modelo mental, protocolos, reglas del monitor, costos y límites, estado de fuentes, troubleshooting, glosario) y enlazarlo desde el README | `TBD` |

## Log

- **L1** — "vamos a implementar esto https://github.com/jsantiscl/switch2-zelda-stock-cl entiendelo y dame un paso a paso" (pedido original, verbatim)
- **L2** — Respuesta inicial: explicación de arquitectura (dos rutas: Python/Actions legacy vs Cloudflare Worker activa), lógica de estado diff-based y baseline, anti-bot, JSON-LD + fallback, alertas accionables, filtro de precio 500.000–2.000.000 CLP, discovery vía Bing RSS, tratamiento especial de Mercado Libre Tienda Oficial Nintendo, y costo de Actions vs Cloudflare.
- **L3** — Decisiones del humano: ruta "Cloudflare Worker (completa)" (S2) y ubicación "…/IA/switch2-zelda-stock-cl" (S3).
- **L4** — Entorno verificado: `gh` CLI ausente, `wrangler` no instalado, sin credenciales de Cloudflare en el entorno, Node v24.11.1 y Python 3.12.3 disponibles. Los pasos que requieren cuentas externas (crear el repo, `wrangler deploy`, secrets) quedan documentados como pasos manuales para el humano.
- **L5** — T1 y T2 completados: motor y workflows copiados de upstream, identidad parametrizada (`GITHUB_OWNER`/`GITHUB_REPO` en `wrangler.jsonc`, `NOTIFY_USER` opcional, `GITHUB_REPOSITORY` obligatorio en el runner) y línea base reiniciada (`state/cloudflare-state.json` con `initialized: false`). Sin rastros de `jsantiscl` ni del usuario de notificación del upstream.
- **L6** — T3 completado: 5 tests offline en verde. Descubrimiento relevante: el motor **exige dos lecturas consecutivas** de "disponible" antes de alertar (`state.pending_available`), por lo que la primera corrida con stock no abre Issue sino que deja la confirmación pendiente. El test quedó escrito contra esa regla real.
- **L7** — T4 y T5 completados: README con puesta en marcha, script `configure-owner.mjs`, `.gitignore`, `npm test` / `npm run check`. Verificación: 5/5 tests en verde, `node --check` sin errores en los tres módulos, los 4 workflows parsean como YAML válido. Commits `ffb9a79`, `00d6fd5`, `5586f40` en `main`.
- **L8** — Repo público `ricardoaevt/switch2-zelda-stock-cl` creado y pusheado; Worker importado desde el dashboard de Cloudflare (build-on-push); circuito verificado en producción: corridas `repository_dispatch` cada 60 s, `state/cloudflare-state.json` con `initialized: true`, commits del bot. Medición en vivo del estado real de las 7 tiendas (Paris `available` $719.990, Bestmart y Mathogames 404, WePlay 403) y detección del hueco de alertas: para las tiendas de la lista fija la alerta exige transición desde un snapshot previo, por lo que una tienda que aparece disponible después de fallar no genera aviso.
- **L9** — T7 en curso: `MANUAL.md` creado con el conocimientoOperational acumulado (modelo mental de las cuatro piezas, por qué el motor vive en Actions y no en el Worker, los tres protocolos de disparo y cómo dispararlo desde el homelab, reglas de confianza del monitor, costos y límites con números medidos, estado real de cada fuente, matriz de troubleshooting y glosario).
