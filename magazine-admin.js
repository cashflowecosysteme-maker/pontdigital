// PONT DIGITAL — administration des editions Heyzine (module ajoute, sans modifier GBP)
const xhtml = (x) => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeHTTPS = (x) => { try { const u = new URL(String(x || '')); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
const isHeyzine = (x) => { const u = safeHTTPS(x); if (!u) return false; const h = new URL(u).hostname.toLowerCase(); return h === 'heyzine.com' || h.endsWith('.heyzine.com'); };

export async function saveMagazineIssue(request, env) {
  const f = await request.formData();
  const month = String(f.get('issue_month') || '');
  const title = String(f.get('title') || '').trim().slice(0, 180);
  const heyzine = String(f.get('heyzine_url') || '').trim();
  const cover = String(f.get('cover_url') || '').trim();
  const intro = String(f.get('introduction') || '').trim().slice(0, 850);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !title || !isHeyzine(heyzine) || (cover && !safeHTTPS(cover))) {
    return Response.redirect(new URL('/?msg=magazine_invalid', request.url), 303);
  }
  const published = f.get('published') === '1' ? 1 : 0;
  await env.DB.prepare(`INSERT INTO magazine_issues (issue_month,title,heyzine_url,cover_url,introduction,published)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(issue_month) DO UPDATE SET title=excluded.title,heyzine_url=excluded.heyzine_url,
    cover_url=excluded.cover_url,introduction=excluded.introduction,published=excluded.published,updated_at=CURRENT_TIMESTAMP`)
    .bind(month, title, heyzine, cover, intro, published).run();
  return Response.redirect(new URL('/?msg=magazine_saved', request.url), 303);
}

export async function toggleMagazineIssue(request, env) {
  const f = await request.formData();
  const month = String(f.get('issue_month') || '');
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    await env.DB.prepare('UPDATE magazine_issues SET published = CASE WHEN published=1 THEN 0 ELSE 1 END, updated_at=CURRENT_TIMESTAMP WHERE issue_month=?').bind(month).run();
  }
  return Response.redirect(new URL('/?msg=magazine_saved', request.url), 303);
}

export function renderMagazinePanel(issues) {
  const rows = (issues || []).map(i => `<tr><td><strong>${xhtml(i.issue_month)}</strong></td><td><strong>${xhtml(i.title)}</strong><br><a target="_blank" rel="noopener" href="${xhtml(safeHTTPS(i.heyzine_url))}" style="color:var(--gold);font-size:.8rem;">Voir sur Heyzine ↗</a></td><td>${i.published ? '🟢 Publiée' : '⚪ Masquée'}</td><td>
  <form method="POST" action="/api/magazine/toggle"><input type="hidden" name="issue_month" value="${xhtml(i.issue_month)}"><button class="btn-sm btn-ghost" type="submit">${i.published ? 'Masquer' : 'Publier'}</button></form>
  </td></tr>`).join('');
  return `<div id="panel-magazine" class="tab-panel">
    <section class="admin-card">
      <h2 class="display" style="color:var(--gold);font-size:1.8rem;margin-bottom:12px;">📖 Revue Heyzine — Éditions mensuelles</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px;">Enregistre le lien de chaque édition. La plus récente édition publiée sera affichée au-dessus de la recherche publique. Les éditions précédentes restent accessibles dans les archives. Aucun formulaire de rendez-vous n'est dupliqué.</p>
      <form method="POST" action="/api/magazine/save">
        <div class="field-grid">
          <div class="field"><label>Mois de l'édition *</label><input name="issue_month" type="month" required></div>
          <div class="field"><label>Titre *</label><input name="title" required maxlength="180" placeholder="Édition de novembre 2026"></div>
          <div class="field"><label>URL de la revue Heyzine *</label><input name="heyzine_url" type="url" required placeholder="https://heyzine.com/flip-book/..."></div>
          <div class="field"><label>URL de couverture (facultative)</label><input name="cover_url" type="url" placeholder="https://..."></div>
        </div>
        <div class="field" style="margin-top:12px;"><label>Présentation de l'édition</label><textarea name="introduction" rows="3" maxlength="850" placeholder="Portraits, dossiers et entrepreneurs à découvrir..."></textarea></div>
        <label class="check-row" style="margin-top:12px;"><input type="checkbox" name="published" value="1" checked> Publier l'édition sur le site</label>
        <p style="color:var(--text-muted);font-size:.8rem;margin:8px 0 12px;">Enregistrer à nouveau un mois déjà présent remplace uniquement les renseignements de cette édition.</p>
        <button class="btn-primary" type="submit">Enregistrer l'édition</button>
      </form>
    </section>
    <section class="admin-card">
      <h2 class="display" style="font-size:1.55rem;color:#fff;margin-bottom:14px;">Archives des éditions</h2>
      <div class="table-scroll"><table class="pd-table"><thead><tr><th>Mois</th><th>Édition</th><th>Visibilité</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">Aucune édition enregistrée pour le moment.</td></tr>'}</tbody></table></div>
    </section>
  </div>`;
}
