import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runMonitor } from "../src/monitor-core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_PATH = path.join(HERE, "..", "src", "monitor-core.js");

// Minuto 2: dispara el escaneo de catálogos (minuto % 2 === 0).
const SCHEDULED_CATALOG_TIME = Date.parse("2026-01-01T00:02:00.000Z");

// Minuto 5: dispara el buscador por tienda (minuto % 5 === 0).
const SCHEDULED_SEARCH_TIME = Date.parse("2026-01-01T00:05:00.000Z");

const OWNER = "test-owner";
const REPO = "test-repo";
const STATE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/state/cloudflare-state.json`;
const ISSUES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/issues`;
const STATE_PATH = "state/cloudflare-state.json";

// Minuto 7: no dispara descubrimiento amplio (15), catálogos (2), redes (5)
// ni escaneo de estuches (5). Aísla el comportamiento de las tiendas conocidas.
const SCHEDULED_TIME = Date.parse("2026-01-01T00:07:00.000Z");

const ENV = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: OWNER,
  GITHUB_REPO: REPO,
  NOTIFY_USER: OWNER,
};

function storeFixture({ availability, price = "699990", body = "" }) {
  return `<!doctype html>
<html>
  <head><title>Consola Nintendo Switch 2 The Legend of Zelda 40th Anniversary</title></head>
  <body>
    <h1>Nintendo Switch 2 The Legend of Zelda 40th Anniversary</h1>
    <script type="application/ld+json">
    {
      "@type": "Product",
      "name": "Consola Nintendo Switch 2 The Legend of Zelda 40th Anniversary Edition",
      "offers": {
        "@type": "Offer",
        "price": "${price}",
        "priceCurrency": "CLP",
        "availability": "https://schema.org/${availability}"
      }
    }
    </script>
    ${body}
  </body>
</html>`;
}

const CHALLENGE_PAGE = `<!doctype html>
<html><head><title>Just a moment...</title></head>
<body><p>Checking your browser before accessing the site.</p></body></html>`;

const GENERIC_PAGE = `<!doctype html>
<html><head><title>Página sin producto</title></head><body><p>Sin información.</p></body></html>`;

/**
 * Stub de fetch: intercepta la API de GitHub y devuelve fixtures HTML para
 * cualquier tienda, sin tocar la red.
 */
function makeFetch({ state = null, page }) {
  const calls = { issues: [], statePuts: [], fetched: [] };

  const stub = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = (init.method || "GET").toUpperCase();
    calls.fetched.push(url);

    if (url === STATE_URL) {
      if (method === "PUT") {
        calls.statePuts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ content: {} }), { status: 200 });
      }
      if (!state) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(
        JSON.stringify({
          sha: "state-sha",
          content: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
        }),
        { status: 200 },
      );
    }

    if (url === ISSUES_URL) {
      calls.issues.push(JSON.parse(init.body || "{}"));
      return new Response(JSON.stringify({ number: calls.issues.length }), { status: 201 });
    }

    if (url.includes("bing.com")) {
      return new Response(
        "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel></channel></rss>",
        { status: 200, headers: { "content-type": "application/rss+xml" } },
      );
    }

    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }

    if (url.includes("mercadolibre.cl")) {
      return new Response(GENERIC_PAGE, { status: 200 });
    }

    return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
  };

  return { stub, calls };
}

function decodeSavedState(call) {
  return JSON.parse(Buffer.from(call.content, "base64").toString("utf8"));
}

test("primera corrida construye la línea base y no genera alertas", async () => {
  const { stub, calls } = makeFetch({
    page: storeFixture({ availability: "OutOfStock", body: "<p>Producto agotado</p>" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    const result = await runMonitor(ENV, SCHEDULED_TIME, false);

    assert.equal(result.alerts, 0, "la línea base no debe generar alertas");
    assert.equal(result.initialized, true);
    assert.equal(calls.issues.length, 0, "no debe abrir Issue en la línea base");
    assert.equal(calls.statePuts.length, 1, "debe persistir el estado inicial");

    const state = decodeSavedState(calls.statePuts[0]);
    assert.equal(state.initialized, true);
    assert.ok(Object.keys(state.stores).length > 0, "debe guardar el snapshot de las tiendas");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("el pasaje a disponible exige dos lecturas y recién ahí abre el Issue", async () => {
  const baseline = makeFetch({
    page: storeFixture({ availability: "OutOfStock", body: "<p>Producto agotado</p>" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = baseline.stub;

  let state;
  try {
    await runMonitor(ENV, SCHEDULED_TIME, false);
    state = decodeSavedState(baseline.calls.statePuts[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Primera lectura "disponible": queda pendiente de confirmación, sin alerta.
  const first = makeFetch({
    state,
    page: storeFixture({ availability: "InStock", body: "<p>Agregar al carrito</p>" }),
  });
  globalThis.fetch = first.stub;

  let pendingState;
  try {
    const result = await runMonitor(ENV, SCHEDULED_TIME, false);

    assert.equal(result.alerts, 0, "una sola lectura no debe generar alerta");
    assert.equal(first.calls.issues.length, 0, "una sola lectura no debe abrir Issue");
    assert.ok(
      result.pending_availability_confirmations > 0,
      "la disponibilidad queda pendiente de una segunda lectura",
    );
    pendingState = decodeSavedState(first.calls.statePuts[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Segunda lectura consecutiva "disponible": ahí sí se alerta.
  const second = makeFetch({
    state: pendingState,
    page: storeFixture({ availability: "InStock", body: "<p>Agregar al carrito</p>" }),
  });
  globalThis.fetch = second.stub;

  try {
    const result = await runMonitor(ENV, SCHEDULED_TIME, false);

    assert.ok(result.alerts > 0, "el cambio de stock confirmado debe generar alerta");
    assert.equal(second.calls.issues.length, 1, "debe abrir exactamente un Issue");
    assert.match(second.calls.issues[0].title, /novedad/i);
    assert.match(second.calls.issues[0].body, /disponible/i);

    const saved = decodeSavedState(second.calls.statePuts[0]);
    const statuses = Object.values(saved.stores).map((entry) => entry.snapshot.status);
    assert.ok(
      statuses.includes("available"),
      "el estado guardado debe registrar la tienda como disponible",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("una página anti-bot no pisa el último estado confiable ni dispara alerta", async () => {
  const baseline = makeFetch({
    page: storeFixture({ availability: "InStock", body: "<p>Agregar al carrito</p>" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = baseline.stub;

  let state;
  try {
    await runMonitor(ENV, SCHEDULED_TIME, false);
    state = decodeSavedState(baseline.calls.statePuts[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const blocked = makeFetch({ state, page: CHALLENGE_PAGE });
  globalThis.fetch = blocked.stub;

  try {
    const result = await runMonitor(ENV, SCHEDULED_TIME, false);

    assert.equal(result.alerts, 0, "un desafío anti-bot no es una alerta de stock");
    assert.equal(blocked.calls.issues.length, 0, "no debe abrir Issue por un bloqueo");
    assert.ok(result.skipped_stores > 0, "las tiendas bloqueadas se reportan como omitidas");
    assert.equal(
      blocked.calls.statePuts.length,
      0,
      "no debe sobrescribir el estado con lecturas no concluyentes",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("el estado persistido usa la ruta y el versionado esperados", async () => {
  const { stub, calls } = makeFetch({
    page: storeFixture({ availability: "OutOfStock" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    await runMonitor(ENV, SCHEDULED_TIME, false);

    const putUrl = calls.fetched.find((url) => url === STATE_URL);
    assert.ok(putUrl, "debe usar la API de contents para persistir el estado");
    assert.ok(
      calls.fetched.some((url) => url.startsWith(`https://api.github.com/repos/${OWNER}/${REPO}/`)),
      "todas las llamadas de GitHub deben ir al repo configurado",
    );
    assert.ok(
      !calls.fetched.some((url) => url.includes("jsantiscl")),
      "no debe quedar ninguna referencia al owner del upstream",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("el monitor exige GITHUB_TOKEN y no corre sin él", async () => {
  await assert.rejects(
    () => runMonitor({ ...ENV, GITHUB_TOKEN: undefined }, SCHEDULED_TIME, false),
    /Missing GITHUB_TOKEN/,
  );
});

// S12: una tienda de la lista fija que aparece disponible sin snapshot previo
// (porque sus lecturas anteriores fallaron) debe generar alerta, igual que
// ya ocurre con las tiendas descubiertas.
test("una tienda conocida sin snapshot previo que aparece disponible genera alerta", async () => {
  const state = {
    version: 1,
    initialized: true,
    stores: {},
    discovered: {},
    pending_available: {},
  };

  const available = makeFetch({
    state,
    page: storeFixture({ availability: "InStock", body: "<p>Agregar al carrito</p>" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = available.stub;

  try {
    const result = await runMonitor(ENV, SCHEDULED_TIME, false);

    assert.ok(result.alerts > 0, "una tienda disponible sin historial debe alertar");
    assert.equal(available.calls.issues.length, 1, "debe abrir un Issue");
    assert.match(available.calls.issues[0].body, /disponible/i);

    const saved = decodeSavedState(available.calls.statePuts[0]);
    const statuses = Object.values(saved.stores).map((entry) => entry.snapshot.status);
    assert.ok(
      statuses.includes("available"),
      "el estado debe registrar las tiendas como disponibles",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("una tienda conocida sin snapshot previo que sigue agotada no alerta", async () => {
  const state = {
    version: 1,
    initialized: true,
    stores: {},
    discovered: {},
    pending_available: {},
  };

  const soldOut = makeFetch({
    state,
    page: storeFixture({ availability: "OutOfStock", body: "<p>Producto agotado</p>" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = soldOut.stub;

  try {
    const result = await runMonitor(ENV, SCHEDULED_TIME, false);

    assert.equal(result.alerts, 0, "agotado sin historial no es una alerta");
    assert.equal(soldOut.calls.issues.length, 0, "no debe abrir Issue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// S13: la ficha de Mathogames que vigila el motor debe ser la vigente.
test("la URL de Mathogames en STORES es la vigente", async () => {
  const source = await readFile(CORE_PATH, "utf8");

  assert.ok(
    source.includes(
      "https://www.mathogames.cl/consolas-switch-2/2576-preventa-consola-nintendo-switch-2-the-legend-of-zelda-40th-anniversary-singapur-version.html",
    ),
    "STORES debe apuntar a la ficha vigente de Mathogames",
  );
  assert.ok(
    !source.includes("2538-preventa-dia-1"),
    "no debe quedar la URL caída de Mathogames",
  );
});

// S14: fuentes muertas fuera y la tienda nueva verificada dentro.
test("las fuentes muertas salen y entra la tienda nueva verificada", async () => {
  const source = await readFile(CORE_PATH, "utf8");

  assert.ok(
    source.includes(
      "https://www.imperiogamers.cl/product/preventa-nintendo-switch-2-edicion-the-legend-of-zelda",
    ),
    "debe vigilar Imperio Gamers (verificada: 200, preventa, $699.990)",
  );
  assert.ok(!source.includes("bestmart.cl/products/consola-nintendo-switch-2"), "Bestmart da 404");
  assert.ok(!source.includes("weplay.cl"), "WePlay da 403");
  assert.ok(!source.includes("simple.ripley.cl/tecno/nintendo/consolas"), "Ripley da 403");
  assert.ok(!source.includes("lider.cl/browse"), "Lider no expone la consola");
  assert.ok(!source.includes("sniper.cl/collections/todos-los-productos"), "Sniper no expone la consola");
  assert.ok(!source.includes("web.facebook.com/p/Zona-Gamer"), "la fuente directa de Zona Gamer esta caida");
  assert.ok(!source.includes("govern1.com/CL/Iquique"), "el espejo de Zona Gamer esta caido");
});

// S15: el escaneo de catálogos debe leer el producto del JSON embebido de la
// página (Falabella lo publica así), no solo de los <a href>.
test("el escaneo de catalogos encuentra la consola Zelda 40 en el JSON embebido", async () => {
  const page = `<!doctype html>
<html><head><title>Nintendo Switch 2</title></head>
<body>
<div class="card">
  <h3>Nintendo Consola Switch 2 256GB The Legend of Zelda 40 . Version Global Original</h3>
  <p>por pocketzonecl</p>
  <p>$ 819.990 -20% $ 829.990</p>
  <a href="javascript:void(0)">agregar al carro</a>
  <p>entrega manana</p>
</div>
<script type="application/json">{&quot;@type&quot;:&quot;ListItem&quot;,&quot;item&quot;:{&quot;@type&quot;:&quot;Product&quot;,&quot;name&quot;:&quot;Consola Switch 2 256GB The Legend of Zelda 40 . Version Global Original&quot;,&quot;url&quot;:&quot;https://www.falabella.com/falabella-cl/product/159555264/consola-nintendo-switch-2-256gb-the-legend-of-zelda-40-aniversario-edicion-especial&quot;}}</script>
</body></html>`;

  const originalFetch = globalThis.fetch;

  // Primera lectura: el candidato queda pendiente de confirmacion.
  const first = makeFetch({ page });
  globalThis.fetch = first.stub;

  let state1;
  let url;
  try {
    const result = await runMonitor(ENV, SCHEDULED_CATALOG_TIME, false);

    assert.match(
      String(result.retailer_catalogs),
      /Falabella:candidate_/,
      "el catalogo debe reportar un candidato leido del JSON embebido",
    );

    state1 = decodeSavedState(first.calls.statePuts[0]);
    url = Object.keys(state1.retailer_discovered || {}).find((u) =>
      u.includes("159555264"),
    );
    assert.ok(url, "debe registrar la consola descubierta en el catalogo");
    assert.ok(
      state1.pending_available[url],
      "la primera lectura debe quedar pendiente de confirmacion",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Segunda lectura: confirma el stock y abre el Issue.
  const second = makeFetch({ state: state1, page });
  globalThis.fetch = second.stub;

  try {
    await runMonitor(ENV, SCHEDULED_CATALOG_TIME, false);

    assert.equal(second.calls.issues.length, 1, "la segunda lectura debe abrir el Issue");

    const state2 = decodeSavedState(second.calls.statePuts[0]);
    const snapshot = state2.stores[url].snapshot;
    assert.equal(snapshot.status, "available", "el boton de compra debe interpretarse como stock");
    assert.equal(snapshot.price_clp, 819990, "el precio debe salir del bloque del producto");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// S16: regresion. En la misma coleccion conviven otras consolas y accesorios:
// el escaneo no debe tomarlos por la consola Zelda 40.
test("el escaneo de catalogos ignora las otras consolas de la misma pagina", async () => {
  const page = `<!doctype html>
<html><head><title>Nintendo Switch 2</title></head>
<body>
<div class="card">
  <h3>Nintendo Switch Lite Consola Turquesa</h3>
  <p>$ 199.990</p>
  <a href="javascript:void(0)">agregar al carro</a>
</div>
<div class="card">
  <h3>Nintendo Consola Switch 2 256GB The Legend of Zelda 40 . Version Global Original</h3>
  <p>por pocketzonecl</p>
  <p>$ 819.990 -20% $ 829.990</p>
  <a href="javascript:void(0)">agregar al carro</a>
</div>
<script type="application/json">{&quot;@type&quot;:&quot;ListItem&quot;,&quot;item&quot;:{&quot;@type&quot;:&quot;Product&quot;,&quot;name&quot;:&quot;Nintendo Switch Lite Consola Turquesa&quot;,&quot;url&quot;:&quot;https://www.falabella.com/falabella-cl/product/143211057/Nintendo-Switch-Lite-Consola-Turquesa&quot;}},{&quot;@type&quot;:&quot;ListItem&quot;,&quot;item&quot;:{&quot;@type&quot;:&quot;Product&quot;,&quot;name&quot;:&quot;Consola Switch 2 256GB The Legend of Zelda 40 . Version Global Original&quot;,&quot;url&quot;:&quot;https://www.falabella.com/falabella-cl/product/159555264/consola-nintendo-switch-2-256gb-the-legend-of-zelda-40-aniversario-edicion-especial&quot;}}</script>
</body></html>`;

  const { stub, calls } = makeFetch({ page });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    await runMonitor(ENV, SCHEDULED_CATALOG_TIME, false);
    const saved = decodeSavedState(calls.statePuts[0]);
    const found = Object.keys(saved.retailer_discovered || {});

    assert.ok(
      found.some((u) => u.includes("159555264")),
      "debe encontrar la consola Zelda 40",
    );
    assert.ok(
      !found.some((u) => u.includes("143211057")),
      "no debe tomar la Switch Lite por la consola Zelda 40",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// S17: el buscador de la tienda debe encontrar la consola Zelda 40 y descartar
// los demas productos de la pagina (accesorios, juegos y otras consolas).
test("el buscador de tienda encuentra la consola y descarta el resto", async () => {
  const page = `<!doctype html>
<html><body>
  <div class="product">
    <a href="/product/111/juego-zelda-tears-of-the-kingdom">Juego The Legend of Zelda Tears of the Kingdom $ 59.990</a>
  </div>
  <div class="product">
    <a href="/product/222/pro-controller-switch-2-zelda-40">Pro Controller Switch 2 Zelda 40th $ 169.990 agregar al carrito</a>
  </div>
  <div class="product">
    <a href="/product/333/consola-switch-2-256gb-zelda-40">Consola Nintendo Switch 2 256GB The Legend of Zelda 40 $ 819.990 agregar al carro</a>
  </div>
  <div class="product">
    <a href="/product/444/switch-lite">Nintendo Switch Lite Consola Turquesa $ 199.990 agregar al carrito</a>
  </div>
</body></html>`;

  const { stub, calls } = makeFetch({ page });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;

  try {
    // Minuto 5: dispara el buscador de tienda (minute % 5 === 0).
    const result = await runMonitor(ENV, SCHEDULED_SEARCH_TIME, false);

    assert.match(
      String(result.store_searches),
      /candidate_/,
      "el buscador debe reportar candidatos",
    );

    const saved = decodeSavedState(calls.statePuts[0]);
    const found = Object.keys(saved.retailer_discovered || {});

    assert.ok(found.some((u) => u.includes("/333/")), "debe encontrar la consola Zelda 40");
    assert.ok(!found.some((u) => u.includes("/222/")), "no debe tomar el pro controller");
    assert.ok(!found.some((u) => u.includes("/444/")), "no debe tomar la Switch Lite");
    assert.ok(!found.some((u) => u.includes("/111/")), "no debe tomar el juego de Zelda");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
