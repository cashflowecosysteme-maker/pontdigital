// Rapport d’activité fondé sur les enregistrements de Pont Digital.
const monthInQuebec = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit'
});
const monthLabel = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'UTC', year: 'numeric', month: 'long'
});

function utcRecordMonth(value) {
  if (!value) return '';
  const normalized = value.trim().replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : normalized + 'Z');
  return Number.isNaN(date.getTime()) ? '' : monthInQuebec.format(date);
}

export async function renderMonthlyReport(request, db, escapeHtml) {
  const params = new URL(request.url).searchParams;
  const currentMonth = monthInQuebec.format(new Date());
  const input = params.get('month') || '';
  const month = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(input) ? input : currentMonth;
  const monthStart = new Date(month + '-01T00:00:00Z');
  const previousDate = new Date(monthStart);
  previousDate.setUTCMonth(previousDate.getUTCMonth() - 1);
  const previous = previousDate.toISOString().slice(0, 7);
  const { results: clients } = await db.prepare('SELECT id, business_name, city FROM clients ORDER BY business_name, city, id').all();
  const client = clients.find(item => String(item.id) === params.get('client_id'));
  let content = '<p>Sélectionne une entreprise pour afficher son rapport.</p>';

  if (client) {
    const start = new Date(previousDate);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(monthStart);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(2);
    const range = [client.id, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
    const [leads, chatgptLeads, sms, appointments, posts, replies] = await db.batch([
      db.prepare("SELECT created_at AS date FROM heyzine_leads WHERE COALESCE(source_channel, 'heyzine') = 'heyzine' AND client_id = ? AND created_at >= ? AND created_at < ?").bind(...range),
      db.prepare("SELECT created_at AS date FROM heyzine_leads WHERE source_channel = 'chatgpt' AND client_id = ? AND created_at >= ? AND created_at < ?").bind(...range),
      db.prepare("SELECT created_at AS date FROM sms_threads WHERE client_id = ? AND direction = 'inbound' AND created_at >= ? AND created_at < ?").bind(...range),
      db.prepare('SELECT appointment_datetime AS date, status FROM appointments WHERE client_id = ? AND appointment_datetime >= ? AND appointment_datetime < ?').bind(...range),
      db.prepare('SELECT created_at AS date FROM google_posts WHERE client_id = ? AND created_at >= ? AND created_at < ?').bind(...range),
      db.prepare("SELECT reply_updated_at AS date FROM google_reviews WHERE client_id = ? AND reply_comment <> '' AND reply_updated_at >= ? AND reply_updated_at < ?").bind(...range)
    ]);
    const count = (period, rows, predicate = () => true, local = false) => rows.results.filter(row => {
      const recordMonth = local && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.date) ? row.date.slice(0, 7) : utcRecordMonth(row.date);
      return recordMonth === period && predicate(row);
    }).length;
    const metrics = [
      ['Demandes reçues via Heyzine', leads],
      ['Demandes reçues via ChatGPT', chatgptLeads],
      ['Textos reçus et associés à l’entreprise', sms],
      ['Rendez-vous confirmés', appointments, row => row.status === 'confirmed', true],
      ['Rendez-vous à qualifier', appointments, row => (row.status || 'pending_qualification') === 'pending_qualification', true],
      ['Rendez-vous annulés ou à replanifier', appointments, row => ['cancelled', 'reschedule_requested'].includes(row.status), true],
      ['Publications Google faites via Pont Digital', posts],
      ['Réponses aux avis Google datées', replies]
    ];
    const rows = metrics.map(([label, ...args]) => {
      const before = count(previous, ...args);
      const after = count(month, ...args);
      const change = after - before;
      return `<tr><th scope="row">${label}</th><td>${before}</td><td>${after}</td><td>${change > 0 ? '+' : ''}${change}</td></tr>`;
    }).join('');
    content = `<section class="admin-card report-results"><h2 class="display">${escapeHtml(client.business_name)} · ${escapeHtml(client.city)}</h2>
      <p>${monthLabel.format(monthStart)} · Heures du Québec</p>
      <div class="report-table"><table><thead><tr><th scope="col">Activité</th><th scope="col">${monthLabel.format(previousDate)}</th><th scope="col">${monthLabel.format(monthStart)}</th><th scope="col">Écart</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p>Les rendez-vous sont comptés selon la date prévue et leur statut actuel. Les réponses Google sans date sont exclues. Une réponse mise à jour est comptée à sa dernière date connue. Les textos sans entreprise associée sont exclus.</p>
      <h3 class="display">Travaux réalisés et évolution de la visibilité</h3>
      <div class="notes" contenteditable="true" role="textbox" aria-label="Travaux réalisés et évolution de la visibilité" aria-multiline="true"></div>
      <p class="controls">Tu peux saisir tes observations et les imprimer avec ce rapport. Les observations saisies ici restent sur cette page jusqu’à sa fermeture ou son rechargement.</p>
      <button type="button" class="btn-ghost controls" onclick="window.print()">Imprimer / enregistrer en PDF</button></section>`;
  }

  return `<style>
  .monthly-report-panel .report-filters{display:flex;flex-wrap:wrap;align-items:end;gap:1rem;margin-top:1rem}
  .monthly-report-panel .report-filters .field{min-width:min(100%,200px)}
  .monthly-report-panel .report-results > * + *{margin-top:.85rem}
  .monthly-report-panel h1,.monthly-report-panel h2{color:var(--gold)}
  .monthly-report-panel .report-table{overflow-x:auto}
  .monthly-report-panel table{width:100%;border-collapse:collapse}
  .monthly-report-panel td,.monthly-report-panel th{padding:.75rem;text-align:left;border-bottom:1px solid var(--border)}
  .monthly-report-panel thead th{color:var(--gold)}
  .monthly-report-panel .notes{min-height:6rem;padding:.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);white-space:pre-wrap}
  @media print{
    body:has(.monthly-report-panel.active){background:white!important;color:black!important}
    body:has(.monthly-report-panel.active) > :not(.admin-wrap),
    body:has(.monthly-report-panel.active) .admin-wrap > :not(.monthly-report-panel),
    .monthly-report-panel .controls{display:none!important}
    .monthly-report-panel .admin-card{background:white;color:black;border:0;box-shadow:none;padding:0}
    .monthly-report-panel h2,.monthly-report-panel thead th{color:black}
    .monthly-report-panel .report-table{overflow:visible}
  }
  </style>
  <section class="admin-card controls">
    <h1 class="display">Rapports mensuels</h1>
    <form class="report-filters" method="GET" action="/rapports-mensuels">
      <div class="field"><label for="report-client">Entreprise</label><select id="report-client" name="client_id" required><option value="">Choisir une entreprise</option>
      ${clients.map(item => `<option value="${item.id}"${client?.id === item.id ? ' selected' : ''}>${escapeHtml(item.business_name)} · ${escapeHtml(item.city)}</option>`).join('')}</select></div>
      <div class="field"><label for="report-month">Mois</label><input id="report-month" type="month" name="month" value="${month}" required></div>
      <button type="submit" class="btn-primary">Afficher le rapport</button>
    </form>
  </section>
  ${content}`;
}
