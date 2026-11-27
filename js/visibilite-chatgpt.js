const accessOptions = {
  pending: 'À vérifier', requested: 'Accès demandé', reviewing: 'En vérification',
  granted: 'Accès accordé', unavailable: 'Option indisponible'
};
const formOptions = { pending: 'À brancher', connected: 'Branché, à tester', tested: 'Testé' };
const optionalOptions = {
  pending: 'Admissibilité à vérifier', unavailable: 'Option indisponible',
  preparing: 'En préparation', testing: 'À tester', published: 'Publié'
};

function readRecord(value) {
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

export async function readChatgptInsights(db, clientId, month = '') {
  const prefix = `chatgpt:${clientId}:insights:${month}`;
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key GLOB ? ORDER BY key DESC LIMIT 1')
    .bind(prefix + '*').first();
  return readRecord(row?.value);
}

function dateLabel(date) {
  return new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(date + 'T00:00:00Z'));
}

export function renderChatgptInsights(data, escape) {
  if (!data.end) return '<p>Aucun relevé Business Hub enregistré pour cette période.</p>';
  const start = new Date(data.end + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - 27);
  return `<p>Période Business Hub de 28 jours, du ${dateLabel(start.toISOString().slice(0, 10))} au ${dateLabel(data.end)}.</p>
    <dl>
      <dt>Mentions</dt><dd>${escape(data.mentions ?? 'Indisponible')}</dd>
      <dt>Clics vers le site</dt><dd>${escape(data.clicks ?? 'Indisponible')}</dd>
      <dt>Thèmes de découverte</dt><dd>${escape(data.topics || 'Indisponible')}</dd>
    </dl>`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function select(name, label, options, selected) {
  return `<div class="field"><label for="chatgpt-${name}">${label}</label>
    <select id="chatgpt-${name}" name="${name}">
      ${Object.entries(options).map(([value, title]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${title}</option>`).join('')}
    </select></div>`;
}

export async function handleChatgptVisibility(request, db, { escape, renderHead, renderBackground, webhookConfigured }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('client_id') || '';
  const client = /^\d+$/.test(id) && await db.prepare(
    'SELECT id, business_name, city, chatgpt_profile_url FROM clients WHERE id = ?'
  ).bind(id).first();
  if (!client) return new Response('Entreprise introuvable.', { status: 404 });

  const path = `/visibilite-chatgpt?client_id=${client.id}`;
  const settingsKey = `chatgpt:${client.id}:settings`;
  if (request.method === 'POST') {
    const form = await request.formData();
    const value = name => String(form.get(name) ?? '').trim();
    const redirect = message => Response.redirect(new URL(path + '&result=' + message, url), 303);
    let key, data;
    if (value('section') === 'settings') {
      const link = value('form_url');
      if (link && !httpsUrl(link)) return redirect('invalid_settings');
      const access = value('access');
      const formStatus = value('form_status');
      const agent = value('agent');
      const catalog = value('catalog');
      if (!Object.hasOwn(accessOptions, access) || !Object.hasOwn(formOptions, formStatus)
        || !Object.hasOwn(optionalOptions, agent) || !Object.hasOwn(optionalOptions, catalog)) {
        return redirect('invalid_settings');
      }
      data = { access, formStatus, agent, catalog, formUrl: link, work: value('work').slice(0, 5000) };
      key = settingsKey;
    } else if (value('section') === 'insights') {
      const end = value('end');
      const numbers = ['mentions', 'clicks'].map(value);
      if (!validDate(end) || numbers.some(number => number !== '' && !/^\d{1,12}$/.test(number))) {
        return redirect('invalid_insights');
      }
      const [mentions, clicks] = numbers.map(number => number === '' ? null : Number(number));
      data = { end, mentions, clicks, topics: value('topics').slice(0, 3000) };
      key = `chatgpt:${client.id}:insights:${end}`;
    } else {
      return redirect('invalid_settings');
    }

    await db.prepare(`
      INSERT INTO admin_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).bind(key, JSON.stringify(data)).run();
    return redirect(value('section') === 'insights' ? 'insights_saved' : 'settings_saved');
  }

  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(settingsKey).first();
  const settings = readRecord(row?.value);
  const insights = await readChatgptInsights(db, client.id);
  const result = url.searchParams.get('result');
  const notices = {
    settings_saved: 'Suivi de l’entreprise enregistré.', insights_saved: 'Relevé Business Hub enregistré.',
    invalid_settings: 'Vérifie les sélections et le lien HTTPS du formulaire.',
    invalid_insights: 'Indique une date de fin valide et des nombres entiers. Laisse une mesure vide si elle est indisponible.'
  };
  const profile = httpsUrl(client.chatgpt_profile_url);
  const formLink = httpsUrl(settings.formUrl);
  return new Response(`<!doctype html><html lang="fr-CA"><head>${renderHead('Visibilité ChatGPT • Pont Digital')}</head><body>
    ${renderBackground()}
    <header class="site-header"><a class="brand" href="/">Pont Digital • SuperAdmin</a>
      <a class="btn-ghost" href="/">Retour aux entreprises</a></header>
    <main class="admin-wrap">
      <section class="admin-card">
        <h1 class="display">Visibilité ChatGPT</h1>
        <p>${escape(client.business_name)}${client.city ? ' · ' + escape(client.city) : ''}</p>
        ${Object.hasOwn(notices, result) ? `<p class="alert-banner" role="status">${notices[result]}</p>` : ''}
        <div class="header-right" style="margin-top:1rem">
          <a class="btn-ghost" href="https://chatgpt.com/business-hub/" target="_blank" rel="noopener noreferrer">Ouvrir Business Hub</a>
          ${profile ? `<a class="btn-ghost" href="${escape(profile)}" target="_blank" rel="noopener noreferrer">Ouvrir la fiche ChatGPT</a>` : ''}
          <a class="btn-ghost" href="/audit-visibilite">Ouvrir l’audit Google + IA</a>
          <a class="btn-ghost" href="/rapports-mensuels?client_id=${client.id}">Rapports mensuels</a>
        </div>
      </section>
      <form class="admin-card" method="POST" action="${path}">
        <input type="hidden" name="section" value="settings">
        <h2 class="display">Accès et travail sur la fiche</h2>
        <div class="field-grid">
          ${select('access', 'Accès Business Hub', accessOptions, settings.access)}
          ${select('agent', 'Agent Business', optionalOptions, settings.agent)}
          ${select('catalog', 'Catalogue de produits', optionalOptions, settings.catalog)}
        </div>
        <div class="field" style="margin-top:1rem"><label for="chatgpt-work">Travaux réalisés et constats de visibilité</label>
          <textarea id="chatgpt-work" name="work" rows="5" maxlength="5000" placeholder="Indique la recherche, la date, la source et le constat, ou les modifications réalisées.">${escape(settings.work || '')}</textarea></div>
        <h2 class="display" style="margin-top:1rem">Demandes et SMS au bureau</h2>
        <div class="field-grid">
          <div class="field"><label for="chatgpt-form-url">Lien public du formulaire de ce commerce</label>
            <input id="chatgpt-form-url" name="form_url" type="url" value="${escape(formLink)}"></div>
          ${select('form_status', 'État du formulaire', formOptions, settings.formStatus)}
        </div>
        <div class="field" style="margin-top:.75rem"><label for="chatgpt-webhook-url">Webhook à utiliser dans l’intégration du formulaire</label>
          <input id="chatgpt-webhook-url" type="url" readonly value="${escape(url.origin + '/webhook/chatgpt?client_id=' + client.id)}"></div>
        <p>${webhookConfigured ? 'Secret webhook configuré. Le test du formulaire confirme la réception au bureau.' : 'Secret webhook ChatGPT à configurer dans Cloudflare.'}</p>
        <div class="header-right" style="margin-top:1rem">
          <button class="btn-primary" type="submit">Enregistrer le suivi</button>
          ${formLink ? `<a class="btn-ghost" href="${escape(formLink)}" target="_blank" rel="noopener noreferrer">Ouvrir le formulaire</a>` : ''}
        </div>
      </form>
      <section class="admin-card">
        <h2 class="display">Statistiques Business Hub</h2>
        ${renderChatgptInsights(insights, escape)}
        <form method="POST" action="${path}" style="margin-top:1rem">
          <input type="hidden" name="section" value="insights">
          <div class="field-grid">
            <div class="field"><label for="chatgpt-end">Date de fin de la période</label><input id="chatgpt-end" name="end" type="date" required value="${escape(insights.end || '')}"></div>
            <div class="field"><label for="chatgpt-mentions">Mentions</label><input id="chatgpt-mentions" name="mentions" type="number" min="0" step="1" value="${escape(insights.mentions ?? '')}"></div>
            <div class="field"><label for="chatgpt-clicks">Clics vers le site</label><input id="chatgpt-clicks" name="clicks" type="number" min="0" step="1" value="${escape(insights.clicks ?? '')}"></div>
          </div>
          <div class="field" style="margin-top:.75rem"><label for="chatgpt-topics">Thèmes de découverte</label><textarea id="chatgpt-topics" name="topics" rows="3" maxlength="3000">${escape(insights.topics || '')}</textarea></div>
          <p>Laisse une mesure vide si Business Hub ne l’affiche pas. Le rapport mensuel reprend le dernier relevé dont la période se termine dans le mois choisi.</p>
          <button class="btn-primary" type="submit" style="margin-top:1rem">Enregistrer le relevé</button>
        </form>
      </section>
    </main></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
