// ============================================================================
// PONT DIGITAL — LOGIQUE INTERFACE SUPER ADMIN
// (4 ONGLETS + MODALE + NYXIA + LECTURE/ÉDITION HORAIRES GBP SÉCURISÉE)
// ============================================================================

var GBP_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
var gbpLoadRequestSeq = 0;
var gbpNyxiaRequestSeq = 0;

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(function (panel) {
    panel.classList.toggle('active', panel.id === 'panel-' + tabId);
  });
  try {
    sessionStorage.setItem('pd_active_tab', tabId);
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', function () {
  var saved = null;
  try {
    saved = sessionStorage.getItem('pd_active_tab');
  } catch (_) {}
  if (saved && document.getElementById('panel-' + saved)) {
    switchTab(saved);
  }
});

function openEditModal(c) {
  document.getElementById('edit-client_id').value = c.id;
  document.getElementById('edit-business_name').value = c.business_name || '';
  document.getElementById('edit-city').value = c.city || '';
  document.getElementById('edit-category').value = c.category || '';
  document.getElementById('edit-services').value = c.services || '';
  document.getElementById('edit-service_areas').value = c.service_areas || '';
  document.getElementById('edit-public_address').value = c.public_address || '';
  document.getElementById('edit-show_public_address').checked = Boolean(Number(c.show_public_address));
  document.getElementById('edit-advertorial_text').value = c.advertorial_text || '';
  var socials = {};
  try {
    socials = JSON.parse(c.social_links || '{}') || {};
  } catch (_) {}
  document.getElementById('edit-social_website').value = socials.website || '';
  document.getElementById('edit-social_facebook').value = socials.facebook || '';
  document.getElementById('edit-social_instagram').value = socials.instagram || '';
  document.getElementById('edit-social_linkedin').value = socials.linkedin || '';
  document.getElementById('edit-social_tiktok').value = socials.tiktok || '';
  document.getElementById('edit-social_youtube').value = socials.youtube || '';
  document.getElementById('edit-phone').value = c.phone || '';
  document.getElementById('edit-client_email').value = c.client_email || '';
  var reviewUrlEl = document.getElementById('edit-google_review_url');
  if (reviewUrlEl) reviewUrlEl.value = c.google_review_url || '';
  document.getElementById('edit-booking_calendar_url').value = c.booking_calendar_url || '';
  document.getElementById('edit-heyzine_url').value = c.heyzine_url || '';
  document.getElementById('edit-interview_video_url').value = c.interview_video_url || '';
  document.getElementById('edit-cover_photo_url').value = c.cover_photo_url || '';
  document.getElementById('edit-booking_notes').value = c.booking_notes || '';
  var photos = [];
  try {
    photos = JSON.parse(c.gallery_urls || '[]');
  } catch (_) {}
  document.getElementById('edit-gallery_urls').value = photos.join(', ');
  document.getElementById('edit-modal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('open');
}

function copyWebhook(url, btn) {
  navigator.clipboard.writeText(url).then(function () {
    var old = btn.textContent;
    btn.textContent = '✓ Copié !';
    setTimeout(function () {
      btn.textContent = old;
    }, 2000);
  });
}

function togglePostFields() {
  var type = document.getElementById('post-topic-type').value;
  var box = document.getElementById('event-offer-fields');
  var coupon = document.getElementById('coupon-field');
  var actionWrap = document.getElementById('action-type-wrap');
  box.style.display = (type === 'OFFER' || type === 'EVENT') ? 'grid' : 'none';
  coupon.style.display = (type === 'OFFER') ? 'block' : 'none';
  actionWrap.style.display = (type === 'OFFER') ? 'none' : 'block';
}

async function draftPostWithNyxia() {
  var clientId = document.getElementById('post-client-select').value;
  var topicType = document.getElementById('post-topic-type').value;
  var editorialAngle = document.getElementById('post-editorial-angle').value;
  var customTopic = document.getElementById('post-custom-topic').value;
  var btn = document.getElementById('btn-nyxia-draft');

  if (!clientId) {
    alert('Choisis d’abord un entrepreneur dans la liste déroulante.');
    return;
  }

  var oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ NyXia rédige un contenu métier pertinent...';

  try {
    var res = await fetch('/api/nyxia/draft-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        topic_type: topicType,
        editorial_angle: editorialAngle,
        angle: customTopic
      })
    });
    var data = await res.json();
    if (data.draft) {
      document.getElementById('post-summary').value = data.draft;
    }
    if (data.default_media && !document.getElementById('post-media-url').value) {
      document.getElementById('post-media-url').value = data.default_media;
    }
    if (data.default_cta && !document.getElementById('post-cta-url').value) {
      document.getElementById('post-cta-url').value = data.default_cta;
    }
  } catch (e) {
    alert('Erreur lors de la rédaction par NyXia.');
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

// ============================================================================
// GESTION PROFESSIONNELLE DE LA FICHE GOOGLE (LECTURE, HORAIRES, CONFIRMATION)
// ============================================================================

function clearDayHours(dayCode) {
  ['open1', 'close1', 'open2', 'close2'].forEach(function (suffix) {
    var el = document.getElementById('day_' + dayCode + '_' + suffix);
    if (el) el.value = '';
  });
}

function resetProfileLoadedState() {
  gbpLoadRequestSeq += 1;
  gbpNyxiaRequestSeq += 1;

  var flag = document.getElementById('profile-loaded-flag');
  if (flag) flag.value = '0';

  var clearConfirm = document.getElementById('confirm-clear-special-hours');
  if (clearConfirm) clearConfirm.value = '0';

  ['profile-description', 'profile-services', 'profile-service-areas', 'profile-categories', 'profile-notes'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });

  ['apply-description', 'apply-hours', 'apply-special-hours'].forEach(function (id) {
    var chk = document.getElementById(id);
    if (chk) chk.checked = false;
  });

  var loadBtn = document.getElementById('btn-load-gbp');
  if (loadBtn) {
    loadBtn.disabled = false;
    loadBtn.textContent = '🔄 Charger la fiche Google actuelle';
  }
  var nyxiaBtn = document.getElementById('btn-nyxia-profile');
  if (nyxiaBtn) {
    nyxiaBtn.disabled = false;
    nyxiaBtn.textContent = '✨ Générer Description, Catégories & Services avec NyXia';
  }

  var status = document.getElementById('profile-load-status');
  if (status) {
    status.style.color = 'var(--text-muted)';
    status.textContent = 'Clique sur « 🔄 Charger la fiche Google actuelle » pour lire les vrais horaires et la description de ce client.';
  }
  GBP_DAYS.forEach(clearDayHours);
  var list = document.getElementById('special-hours-list');
  if (list) list.innerHTML = '';
}

function addSpecialHourRow(item) {
  var list = document.getElementById('special-hours-list');
  if (!list) return;
  var data = item || { date: '', closed: true, open: '', close: '' };

  var row = document.createElement('div');
  row.className = 'special-hour-row';
  row.style.cssText = 'display:grid;grid-template-columns:160px 130px 130px 130px auto;gap:8px;align-items:center;padding:8px 10px;border-radius:10px;background:rgba(6,10,24,.65);border:1px solid var(--border);';

  row.innerHTML =
    '<input type="date" class="sh-date" value="' + (data.date || '') + '" style="padding:7px 9px;border-radius:8px;background:rgba(6,10,24,.9);border:1px solid var(--border);color:#fff;">' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--text-secondary);cursor:pointer;">' +
      '<input type="checkbox" class="sh-closed" ' + (data.closed ? 'checked' : '') + ' style="width:auto;"> Fermé' +
    '</label>' +
    '<input type="time" class="sh-open" value="' + (data.open || '') + '" ' + (data.closed ? 'disabled' : '') + ' style="padding:7px 9px;border-radius:8px;background:rgba(6,10,24,.9);border:1px solid var(--border);color:#fff;">' +
    '<input type="time" class="sh-close" value="' + (data.close || '') + '" ' + (data.closed ? 'disabled' : '') + ' style="padding:7px 9px;border-radius:8px;background:rgba(6,10,24,.9);border:1px solid var(--border);color:#fff;">' +
    '<button type="button" class="btn-sm btn-danger" onclick="this.parentElement.remove()">✕</button>';

  var closedChk = row.querySelector('.sh-closed');
  var openInp = row.querySelector('.sh-open');
  var closeInp = row.querySelector('.sh-close');
  closedChk.addEventListener('change', function () {
    openInp.disabled = closedChk.checked;
    closeInp.disabled = closedChk.checked;
    if (closedChk.checked) {
      openInp.value = '';
      closeInp.value = '';
    }
  });

  list.appendChild(row);
}

function serializeSpecialHours() {
  var rows = document.querySelectorAll('#special-hours-list .special-hour-row');
  var result = [];
  rows.forEach(function (row) {
    var date = row.querySelector('.sh-date').value;
    if (!date) return;
    var closed = row.querySelector('.sh-closed').checked;
    var open = row.querySelector('.sh-open').value;
    var close = row.querySelector('.sh-close').value;
    result.push({ date: date, closed: closed, open: open, close: close });
  });
  var hidden = document.getElementById('special-hours-json');
  if (hidden) hidden.value = JSON.stringify(result);
  return result;
}

function hasAnyRegularHourFilled() {
  for (var i = 0; i < GBP_DAYS.length; i++) {
    var day = GBP_DAYS[i];
    var o1 = (document.getElementById('day_' + day + '_open1') || {}).value || '';
    var c1 = (document.getElementById('day_' + day + '_close1') || {}).value || '';
    var o2 = (document.getElementById('day_' + day + '_open2') || {}).value || '';
    var c2 = (document.getElementById('day_' + day + '_close2') || {}).value || '';
    if ((o1 && c1) || (o2 && c2)) return true;
  }
  return false;
}

async function loadCurrentGoogleProfile() {
  var select = document.getElementById('profile-client-select');
  var clientId = select.value;
  var btn = document.getElementById('btn-load-gbp');
  var status = document.getElementById('profile-load-status');

  if (!clientId) {
    alert('Sélectionne d’abord un entrepreneur connecté dans la liste.');
    return;
  }

  var reqSeq = ++gbpLoadRequestSeq;
  var oldLabel = '🔄 Charger la fiche Google actuelle';
  btn.disabled = true;
  btn.textContent = '⏳ Lecture de la fiche sur Google...';

  try {
    var res = await fetch('/api/google/read-profile?client_id=' + encodeURIComponent(clientId));
    var data = await res.json();

    if (reqSeq !== gbpLoadRequestSeq || select.value !== clientId) {
      return;
    }

    if (!res.ok || data.error) {
      status.style.color = '#fca5a5';
      status.textContent = '⚠️ ' + (data.error || 'Impossible de lire la fiche Google.');
      return;
    }

    document.getElementById('profile-description').value = data.description || '';
    if (data.services !== undefined) document.getElementById('profile-services').value = data.services || '';
    if (data.service_areas !== undefined) document.getElementById('profile-service-areas').value = data.service_areas || '';

    var grid = data.hours_grid || {};
    GBP_DAYS.forEach(function (day) {
      var d = grid[day] || {};
      document.getElementById('day_' + day + '_open1').value = d.open1 || '';
      document.getElementById('day_' + day + '_close1').value = d.close1 || '';
      document.getElementById('day_' + day + '_open2').value = d.open2 || '';
      document.getElementById('day_' + day + '_close2').value = d.close2 || '';
    });

    var list = document.getElementById('special-hours-list');
    list.innerHTML = '';
    (data.special_hours || []).forEach(function (item) {
      addSpecialHourRow(item);
    });

    document.getElementById('profile-loaded-flag').value = '1';
    status.style.color = 'var(--green)';
    status.textContent = '✓ Fiche Google chargée et synchronisée dans D1 : « ' + (data.location_title || 'Établissement') + ' ».';
  } catch (_) {
    if (reqSeq === gbpLoadRequestSeq && select.value === clientId) {
      status.style.color = '#fca5a5';
      status.textContent = '⚠️ Erreur réseau lors de la lecture Google.';
    }
  } finally {
    if (reqSeq === gbpLoadRequestSeq) {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }
}

async function draftProfileWithNyxia() {
  var select = document.getElementById('profile-client-select');
  var clientId = select.value;
  var notes = document.getElementById('profile-notes').value;
  var btn = document.getElementById('btn-nyxia-profile');

  if (!clientId) {
    alert('Choisis d’abord un entrepreneur connecté dans la liste.');
    return;
  }

  var reqSeq = ++gbpNyxiaRequestSeq;
  var defaultLabel = '✨ Générer Description, Catégories & Services avec NyXia';
  btn.disabled = true;
  btn.textContent = '⏳ NyXia optimise la fiche Google...';

  try {
    var res = await fetch('/api/nyxia/draft-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, notes: notes })
    });
    var data = await res.json();

    if (reqSeq !== gbpNyxiaRequestSeq || select.value !== clientId) {
      return;
    }

    if (data.description) {
      document.getElementById('profile-description').value = data.description;
      document.getElementById('apply-description').checked = true;
    }
    if (data.categories) document.getElementById('profile-categories').value = data.categories;
    if (data.services) document.getElementById('profile-services').value = data.services;
  } catch (_) {
    if (reqSeq === gbpNyxiaRequestSeq && select.value === clientId) {
      alert('Erreur lors de la génération par NyXia.');
    }
  } finally {
    if (reqSeq === gbpNyxiaRequestSeq) {
      btn.disabled = false;
      btn.textContent = defaultLabel;
    }
  }
}

function confirmProfileUpdate(event) {
  var select = document.getElementById('profile-client-select');
  if (!select || !select.value) {
    alert('Sélectionne d’abord un entrepreneur.');
    if (event) event.preventDefault();
    return false;
  }

  var specialList = serializeSpecialHours();
  var clearConfirmInput = document.getElementById('confirm-clear-special-hours');
  if (clearConfirmInput) clearConfirmInput.value = '0';

  var applyDesc = document.getElementById('apply-description').checked;
  var applyHours = document.getElementById('apply-hours').checked;
  var applySpecial = document.getElementById('apply-special-hours').checked;
  var loaded = document.getElementById('profile-loaded-flag').value === '1';
  var selectedText = select.options[select.selectedIndex].text;

  var sections = [];
  if (applyDesc) sections.push('• Description officielle Google');
  if (applyHours) {
    if (!hasAnyRegularHourFilled()) {
      alert('⚠️ Sécurité horaires : tu as coché « Publier ces horaires réguliers », mais aucune plage horaire n’est remplie.\nRenseigne au moins un jour d’ouverture ou décoche la case pour éviter d’effacer tous les horaires du client.');
      if (event) event.preventDefault();
      return false;
    }
    sections.push('• Horaires réguliers (jour par jour)');
  }
  if (applySpecial) {
    if (specialList.length === 0) {
      var okClear = confirm(
        '⚠️ SUPPRESSION DES HORAIRES SPÉCIAUX\n\n' +
        'Tu as coché « Publier ces horaires spéciaux » avec une liste VIDE.\n' +
        'Cela va EFFACER tous les horaires spéciaux (jours fériés / congés) sur la fiche Google de :\n' +
        selectedText + '\n\nConfirmes-tu vouloir supprimer tous les horaires spéciaux ?'
      );
      if (!okClear) {
        if (event) event.preventDefault();
        return false;
      }
      if (clearConfirmInput) clearConfirmInput.value = '1';
      sections.push('• Horaires spéciaux : SUPPRESSION CONFIRMÉE (liste vide)');
    } else {
      sections.push('• Horaires spéciaux (' + specialList.length + ' date(s))');
    }
  }

  if (sections.length === 0) {
    var hasD1 = (document.getElementById('profile-services').value || '').trim() ||
                (document.getElementById('profile-service-areas').value || '').trim();
    if (hasD1) {
      return confirm('Aucune case Google n’est cochée.\nEnregistrer uniquement les Services et le Territoire desservi dans D1 pour :\n' + selectedText + ' ?');
    }
    alert('Coche au moins une section à publier sur Google (Description, Horaires réguliers ou Horaires spéciaux).');
    if (event) event.preventDefault();
    return false;
  }

  var warning = '';
  if ((applyHours || applySpecial) && !loaded) {
    warning = '\n\n⚠️ ATTENTION : Tu n’as pas encore cliqué sur « 🔄 Charger la fiche Google actuelle ». Continuer pourrait remplacer les horaires existants du client !';
  }

  var msg = 'Confirmer la publication en direct sur Google Business Profile ?\n\n' +
            'Fiche ciblée : ' + selectedText + '\n\n' +
            'Éléments envoyés à Google :\n' + sections.join('\n') +
            warning;

  if (!confirm(msg)) {
    if (event) event.preventDefault();
    return false;
  }
  return true;
}

function copyTextField(fieldId, btn) {
  var el = document.getElementById(fieldId);
  if (!el || !el.value) return;
  navigator.clipboard.writeText(el.value).then(function () {
    var old = btn.textContent;
    btn.textContent = '✓ Copié !';
    setTimeout(function () {
      btn.textContent = old;
    }, 2000);
  });
}
