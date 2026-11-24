// ============================================================================
// PONT DIGITAL — SITE PUBLIC WORKER (/pontdigital)
// Domaine : pontdigital.nyxia.top
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Liste publique des entreprises partenaires actives (lecture seule D1)
    if (path === '/api/public/clients' && request.method === 'GET') {
      try {
        if (!env.DB) return json({ ok: true, clients: [] });
        const { results } = await env.DB.prepare(`
          SELECT id, business_name, city, category, phone, heyzine_url, interview_video_url, cover_photo_url
          FROM clients
          WHERE status IS NULL OR status = 'active' OR status = 'actif'
          ORDER BY created_at DESC
        `).all();
        return json({ ok: true, clients: results || [] });
      } catch (_) {
        return json({ ok: true, clients: [] });
      }
    }

    // 2. Conversation vivante avec NyXia (bulle bas à droite)
    if (path === '/api/nyxia/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const messages = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
        const fallback =
          "Les Pages Jaunes sont révolues et un site web isolé reste invisible : aujourd'hui, vos clients demandent directement à Google et à l'IA qui appeler dans leur ville. Si votre fiche Google est négligée, c'est votre compétiteur qui décroche l'appel. Réservez votre appel découverte avec notre équipe pour faire le point sur votre visibilité locale !";

        if (!env.OPENROUTER_API_KEY) {
          return json({ ok: true, reply: fallback });
        }

        const model = env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://pontdigital.nyxia.top',
            'X-Title': 'Pont Digital - NyXia Concierge'
          },
          body: JSON.stringify({
            model,
            temperature: 0.65,
            max_tokens: 260,
            messages: [
              {
                role: 'system',
                content:
                  "Tu es NyXia, l'intelligence complice et stratégique de l'agence québécoise Pont Digital. Tu n'es ni un robot de support technique ni un helpdesk ennuyeux : tu as une personnalité chaleureuse, perspicace, directe et bienveillante.\n" +
                  "Ta mission auprès des entrepreneurs et commerçants qui visitent le site :\n" +
                  "1. Leur faire réaliser avec des mots simples et sans jargon que les Pages Jaunes sont révolues, qu'un site web isolé sans vie est désuet, et qu'une fiche Google Business Profile négligée offre littéralement leurs clients sur un plateau à leurs compétiteurs.\n" +
                  "2. Expliquer la différence entre Facebook (où l'on interrompt les gens) et Google + l'IA (SEO et GEO, où le client cherche déjà une solution avec l'intention d'acheter immédiatement).\n" +
                  "3. Présenter la force clé en main de Pont Digital : gestion complète Google Business, publireportage interactif mensuel dans la revue Heyzine avec Google Maps et formulaire intégré, diffusion devant plus de 88 000 contacts (30k Entrepreneurs Québec + 33k CashFlow + 25k LinkedIn), et équipe d'Appointment Setting qui remplit leur agenda.\n" +
                  "4. Ne jamais donner de tarifs ni inventer de prix : explique que chaque entreprise a une réalité propre et invite naturellement à réserver un appel découverte gratuit avec l'équipe.\n" +
                  "Style : français québécois naturel et professionnel, réponses courtes (3 à 5 phrases maximum), vivantes et percutantes."
              },
              ...messages
            ]
          })
        });

        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content?.trim() || fallback;
        return json({ ok: true, reply });
      } catch (_) {
        return json({
          ok: true,
          reply: "Je rencontre un petit nuage cosmique à l'instant, mais notre équipe est prête à analyser votre visibilité Google en direct lors d'un appel découverte !"
        });
      }
    }

    // 3. Favicon
    if (path === '/favicon.ico') {
      return Response.redirect(`${url.origin}/images/FavIcon.png`, 302);
    }

    // 4. Servir index.html et les assets (/css, /js, /images)
    if (env.ASSETS) {
      const targetPath = (path === '/' || path === '') ? '/index.html' : path;
      const primaryUrl = new URL(request.url);
      primaryUrl.pathname = targetPath;

      let assetRes = await env.ASSETS.fetch(new Request(primaryUrl.toString(), request));
      if (assetRes.status !== 404) return assetRes;

      const prefixedUrl = new URL(request.url);
      prefixedUrl.pathname = `/pontdigital${targetPath}`;
      assetRes = await env.ASSETS.fetch(new Request(prefixedUrl.toString(), request));
      if (assetRes.status !== 404) return assetRes;
    }

    return new Response('Page introuvable (vérifie que index.html est bien dans /pontdigital)', { status: 404 });
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
