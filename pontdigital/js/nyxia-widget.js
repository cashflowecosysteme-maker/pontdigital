// ============================================================================
// NYXIA — EXPÉRIENCE CONVERSATIONNELLE VIVANTE (BULLE BAS À DROITE)
// ============================================================================

document.addEventListener('DOMContentLoaded', function () {
  var orb = document.getElementById('nyxia-orb');
  var panel = document.getElementById('nyxia-panel');
  var closeBtn = document.getElementById('nyxia-close');
  var teaser = document.getElementById('nyxia-teaser');
  var teaserClose = document.getElementById('nyxia-teaser-close');
  var form = document.getElementById('nyxia-form');
  var input = document.getElementById('nyxia-input');
  var box = document.getElementById('nyxia-messages');

  if (!orb || !panel || !box) return;

  var history = [];
  var greeted = false;

  function openNyxia() {
    panel.classList.add('open');
    if (teaser) teaser.style.display = 'none';
    if (!greeted) {
      greeted = true;
      appendMessage(
        'nyxia',
        "Allô ! Je suis NyXia ✨ Dis-moi quel est ton métier et ta ville : je te montre en 30 secondes comment tes futurs clients te cherchent sur Google aujourd'hui — et comment éviter que ton compétiteur prenne ta place.",
        true
      );
    }
    setTimeout(function () { input.focus(); }, 120);
  }

  function appendMessage(sender, text, withBookingCta) {
    var div = document.createElement('div');
    div.className = 'msg-bubble ' + (sender === 'user' ? 'msg-user' : 'msg-nyxia');
    div.textContent = text;

    if (sender === 'nyxia' && withBookingCta) {
      var br = document.createElement('br');
      var cta = document.createElement('a');
      cta.href = typeof PONT_DIGITAL_BOOKING_URL !== 'undefined' ? PONT_DIGITAL_BOOKING_URL : '#';
      cta.target = '_blank';
      cta.rel = 'noopener';
      cta.className = 'msg-cta';
      cta.textContent = '📅 Réserver mon appel découverte';
      div.appendChild(br);
      div.appendChild(cta);
    }

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  async function askNyxia(question) {
    var clean = question.trim();
    if (!clean) return;

    appendMessage('user', clean, false);
    history.push({ role: 'user', content: clean });

    var typing = appendMessage('nyxia', 'NyXia réfléchit...', false);

    try {
      var res = await fetch('/api/nyxia/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });
      var data = await res.json();
      var reply = data.reply || "Parlons de votre entreprise lors d'un appel découverte avec notre équipe !";
      typing.remove();
      appendMessage('nyxia', reply, true);
      history.push({ role: 'assistant', content: reply });
    } catch (_) {
      typing.remove();
      appendMessage('nyxia', "Notre équipe peut analyser votre fiche Google en direct : cliquez ci-dessous pour choisir votre créneau !", true);
    }
  }

  orb.addEventListener('click', function () {
    if (panel.classList.contains('open')) panel.classList.remove('open');
    else openNyxia();
  });

  if (closeBtn) closeBtn.addEventListener('click', function () { panel.classList.remove('open'); });
  if (teaserClose && teaser) teaserClose.addEventListener('click', function () { teaser.style.display = 'none'; });

  document.querySelectorAll('.nyxia-quick-prompts button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      askNyxia(btn.getAttribute('data-q') || btn.textContent);
    });
  });

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value;
      input.value = '';
      askNyxia(q);
    });
  }
});
