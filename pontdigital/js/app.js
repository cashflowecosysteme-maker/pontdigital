// ============================================================================
// PONT DIGITAL — LOGIQUE SITE PUBLIC (LIEN RDV + ANNUAIRE D1)
// ============================================================================

const PONT_DIGITAL_BOOKING_URL = 'https://calendar.google.com/calendar/embed?src=ac8b96f538895d515272659016d2c6d154ce0240fc56f4c017354ef8ffcf9520%40group.calendar.google.com&ctz=America%2FToronto';

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.js-booking-link').forEach(function (link) {
    link.href = PONT_DIGITAL_BOOKING_URL;
  });

  loadPartners();
});

async function loadPartners() {
  var grid = document.getElementById('partners-grid');
  if (!grid) return;

  try {
    var res = await fetch('/api/public/clients');
    var data = await res.json();
    var clients = data.clients || [];

    if (clients.length === 0) {
      grid.innerHTML =
        '<div class="glass-card" style="grid-column:1/-1;text-align:center;">' +
        '<p style="color:var(--text-secondary);margin-bottom:14px;">Les premiers portraits de notre nouvelle édition mensuelle sont en cours de mise en ligne.</p>' +
        '<a href="' + PONT_DIGITAL_BOOKING_URL + '" target="_blank" rel="noopener" class="btn-gold">Réserver ma place dans la prochaine revue →</a>' +
        '</div>';
      return;
    }

    grid.innerHTML = clients.map(function (c) {
      var cover = c.cover_photo_url
        ? '<img src="' + esc(c.cover_photo_url) + '" alt="' + esc(c.business_name) + '" class="partner-cover">'
        : '';
      var heyzineBtn = c.heyzine_url
        ? '<a href="' + esc(c.heyzine_url) + '" target="_blank" rel="noopener" class="btn-gold" style="padding:8px 14px;font-size:.82rem;">📖 Lire son portrait</a>'
        : '';
      var videoBtn = c.interview_video_url
        ? '<a href="' + esc(c.interview_video_url) + '" target="_blank" rel="noopener" class="btn-ghost" style="padding:8px 14px;font-size:.82rem;">🎬 Entrevue vidéo</a>'
        : '';

      return (
        '<article class="partner-card">' +
          cover +
          '<div class="partner-body">' +
            '<span class="partner-meta">' + esc(c.category) + ' • ' + esc(c.city) + '</span>' +
            '<h3>' + esc(c.business_name) + '</h3>' +
            (c.phone ? '<p style="font-size:.86rem;color:var(--text-secondary);">📞 ' + esc(c.phone) + '</p>' : '') +
            '<div class="partner-actions">' + heyzineBtn + videoBtn + '</div>' +
          '</div>' +
        '</article>'
      );
    }).join('');
  } catch (_) {
    grid.innerHTML = '<p class="loading-text">Impossible de charger l’annuaire pour le moment.</p>';
  }
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
