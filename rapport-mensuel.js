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
    const [leads, sms, appointments, posts, replies] = await db.batch([
      db.prepare('SELECT created_at AS date FROM heyzine_leads WHERE client_id = ? AND created_at >= ? AND created_at < ?').bind(...range),
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
    content = `<h2>${escapeHtml(client.business_name)} · ${escapeHtml(client.city)}</h2>
      <p>${monthLabel.format(monthStart)} · Heures du Québec</p>
      <table><thead><tr><th scope="col">Activité</th><th scope="col">${monthLabel.format(previousDate)}</th><th scope="col">${monthLabel.format(monthStart)}</th><th scope="col">Écart</th></tr></thead><tbody>${rows}</tbody></table>
      <p>Les rendez-vous sont comptés selon la date prévue et leur statut actuel. Les réponses Google sans date sont exclues. Une réponse mise à jour est comptée à sa dernière date connue. Les textos sans entreprise associée sont exclus.</p>
      <h3>Travaux réalisés et évolution de la visibilité</h3>
      <div class="notes" contenteditable="true" role="textbox" aria-label="Travaux réalisés et évolution de la visibilité" aria-multiline="true"></div>
      <p class="controls">Tu peux saisir tes observations et les imprimer avec ce rapport. Les observations saisies ici restent sur cette page jusqu’à sa fermeture ou son rechargement.</p>
      <button type="button" class="controls" onclick="window.print()">Imprimer / enregistrer en PDF</button>`;
  }

  return `<style>
  .monthly-report{max-width:980px;margin:2rem auto;padding:1.5rem;color:#eee9ff;background:#10152a;border:1px solid #34304c;border-radius:12px}
  .monthly-report form{display:flex;flex-wrap:wrap;align-items:end;gap:1rem;margin:1.25rem 0}
  .monthly-report label{display:grid;gap:.25rem}.monthly-report input,.monthly-report select,.monthly-report button{padding:.5rem;color:inherit;background:#1a2038;border:1px solid #76658c;border-radius:5px}
  .monthly-report table{width:100%;border-collapse:collapse}.monthly-report td,.monthly-report th{padding:.6rem;text-align:left;border-bottom:1px solid #514963}
  .monthly-report .notes{min-height:5rem;padding:.65rem;border:1px solid #76658c;border-radius:5px;white-space:pre-wrap}
  @media print{body{background:white!important}.monthly-report{background:white;color:black;border:0;margin:0;padding:0}.monthly-report .controls{display:none}.monthly-report th,.monthly-report td{border-color:#aaa}}
  </style>
  <main class="monthly-report">
    <a class="controls" href="/">← SuperAdmin</a><h1>Rapports mensuels</h1>
    <form class="controls" method="GET" action="/rapports-mensuels">
      <label>Entreprise<select name="client_id" required><option value="">Choisir une entreprise</option>
      ${clients.map(item => `<option value="${item.id}"${client?.id === item.id ? ' selected' : ''}>${escapeHtml(item.business_name)} · ${escapeHtml(item.city)}</option>`).join('')}</select></label>
      <label>Mois<input type="month" name="month" value="${month}" required></label>
      <button type="submit">Afficher le rapport</button>
    </form>
    ${content}
  </main>`;
}
