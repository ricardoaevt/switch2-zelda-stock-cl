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

## Tasks

| ID | Specs | Route | Commit |
|---|---|---|---|
| T1 | S4, S5 | inline — copiar motor, dispatcher, runner, workflows y estado desde upstream | `feat: base del monitor Switch 2 Zelda 40th (Cloudflare Worker)` |
| T2 | S6, S7 | inline — parametrizar owner/repo/usuario notificado y reiniciar la línea base | `chore: parametrizar identidad del monitor y reiniciar línea base` |
| T3 | S8 | inline — tests offline con `node:test` sobre `runMonitor` con `fetch` simulado | `test: cubrir línea base, transición de stock y desafío anti-bot` |
| T4 | S9, S10 | inline — README de puesta en marcha + scripts de configuración y deploy | `docs: guía de puesta en marcha del monitor y script de configuración` |
| T5 | S8, S9 | inline — verificación final (tests + `node --check`) y commit inicial | `chore: verificación final del monitor Switch 2 Zelda 40th` |

## Log

- **L1** — "vamos a implementar esto https://github.com/jsantiscl/switch2-zelda-stock-cl entiendelo y dame un paso a paso" (pedido original, verbatim)
- **L2** — Respuesta inicial: explicación de arquitectura (dos rutas: Python/Actions legacy vs Cloudflare Worker activa), lógica de estado diff-based y baseline, anti-bot, JSON-LD + fallback, alertas accionables, filtro de precio 500.000–2.000.000 CLP, discovery vía Bing RSS, tratamiento especial de Mercado Libre Tienda Oficial Nintendo, y costo de Actions vs Cloudflare.
- **L3** — Decisiones del humano: ruta "Cloudflare Worker (completa)" (S2) y ubicación "…/IA/switch2-zelda-stock-cl" (S3).
- **L4** — Entorno verificado: `gh` CLI ausente, `wrangler` no instalado, sin credenciales de Cloudflare en el entorno, Node v24.11.1 y Python 3.12.3 disponibles. Los pasos que requieren cuentas externas (crear el repo, `wrangler deploy`, secrets) quedan documentados como pasos manuales para el humano.
