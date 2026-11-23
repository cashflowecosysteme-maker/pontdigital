// ============================================================================
// PONT DIGITAL — LOGIQUE INTERFACE SUPER ADMIN (4 ONGLETS + MODALE + NYXIA)
// ============================================================================

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
  document.getElementById('edit-phone').value = c.phone || '';
  document.getElementById('edit-client_email').value = c.client_email || '';
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
