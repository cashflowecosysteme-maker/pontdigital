// PONT DIGITAL — API publique du repertoire et pages de fiches (lecture seule D1)
// Aucune information de connexion Google, courriel interne, ni note setter n'est exposee.
const CLIENT_COLUMNS = `id,business_name,city,category,services,service_areas,public_address,
  show_public_address,advertorial_text,social_links,gbp_description,gbp_hours_json,
  google_rating,google_review_count,phone,heyzine_url,interview_video_url,
  cover_photo_url,gallery_urls,google_place_id`;
const ACTIVE = `(status IS NULL OR status='active' OR status='actif')`;
const qjson = (o, status = 200) => new Response(JSON.stringify(o), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=120'}});
const ehtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const surl = (s) => { try { const u=new URL(String(s||'')); return ['https:','http:'].includes(u.protocol) ? u.href : ''; } catch{return '';} };
const sjson = (s, fallback) => { try { const a=JSON.parse(s || ''); return a && typeof a === 'object' ? a : fallback; } catch { return fallback; } };
const approvedAddress = (c) => c.show_public_address === 1 || c.show_public_address === '1';
const googleLink = (c) => c.google_place_id
  ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.business_name+', '+c.city+', Québec')}&query_place_id=${encodeURIComponent(c.google_place_id)}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.business_name+', '+c.city+', Québec')}`;

function publicClient(c) {
  const socials = sjson(c.social_links, {});
  const gallery = sjson(c.gallery_urls, []);
  const hours = sjson(c.gbp_hours_json, {});
  return {
    id:c.id, business_name:c.business_name,city:c.city,category:c.category,
    services:c.services||'',service_areas:c.service_areas||'',
    public_address:approvedAddress(c)?(c.public_address||''):'',
    show_address:approvedAddress(c),advertorial_text:c.advertorial_text||'',
    description:c.gbp_description||'',
    hours:hours.regularHours||null, special_hours:hours.specialHours||null,
    google_rating:Number.isFinite(Number(c.google_rating)) && c.google_rating!=null ? Number(c.google_rating):null,
    google_review_count:c.google_review_count==null?null:Number(c.google_review_count),
    phone:c.phone||'',heyzine_url:surl(c.heyzine_url),interview_video_url:surl(c.interview_video_url),
    cover_photo_url:surl(c.cover_photo_url),gallery:Array.isArray(gallery)?gallery.map(surl).filter(Boolean).slice(0,5):[],
    social_links:Object.fromEntries(Object.entries(socials).filter(([k,v])=>['website','facebook','instagram','linkedin','tiktok','youtube'].includes(k)).map(([k,v])=>[k,surl(v)]).filter(([k,v])=>v)),
    google_place_id:c.google_place_id||'',google_url:googleLink(c)
  };
}

function parseCSV(csv, separator) {
  const lines=[];let row=[], value='', quote=false;
  for(let i=0;i<csv.length;i++){
    const c=csv[i];
    if(c==='"'){if(quote&&csv[i+1]==='"'){value+='"';i++;}else quote=!quote;}
    else if(c===separator&&!quote){row.push(value);value='';}
    else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&csv[i+1]==='\n')i++;row.push(value);if(row.some(x=>x.trim()))lines.push(row);row=[];value='';}
    else value+=c;
  }
  if(value||row.length){row.push(value);lines.push(row);}return lines;
}

async function quebecCities(env) {
  // Repertoire officiel du MAMH (source: Donnees Quebec, resource "Liste des municipalites")
  const governmentURL='https://donneesouvertes.affmunqc.net/repertoire/MUN.csv';
  try {
    const response = await fetch(governmentURL, {cf:{cacheTtl:86400,cacheEverything:true}});
    if (!response.ok) throw new Error('Donnees gouvernementales temporairement indisponibles');
    const buffer = await response.arrayBuffer();
    let csv = new TextDecoder('utf-8').decode(buffer);
    if(csv.includes('\uFFFD'))csv=new TextDecoder('windows-1252').decode(buffer);
    csv=csv.replace(/^\uFEFF/,'');
    const head=csv.slice(0,1800).split(/\r?\n/)[0];
    const sep=(head.match(/;/g)||[]).length>(head.match(/,/g)||[]).length?';':',';
    const lines=parseCSV(csv,sep);
    const headers=lines[0].map(x=>x.trim().toLowerCase().replace(/^\uFEFF/,''));
    const nameIndex=headers.indexOf('munnom');
    if(nameIndex<0)throw new Error('Format municipalites inattendu');
    const names=[...new Set(lines.slice(1).map(r=>String(r[nameIndex]||'').trim()).filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,'fr-CA'));
    if(names.length<500)throw new Error('Liste incomplete');
    return {cities:names,source:'MAMH — Données Québec',complete:true};
  }catch(e){
    const {results=[]}=await env.DB.prepare(`SELECT DISTINCT city FROM clients WHERE ${ACTIVE} AND city IS NOT NULL`).all();
    const names=[...new Set(results.map(r=>r.city).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr-CA'));
    return {cities:names,source:'Villes des entreprises inscrites (source officielle temporairement indisponible)',complete:false};
  }
}

function videoEmbed(url) {
  if(!url)return '';
  try{
    const u=new URL(url);let id='';
    if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname) && u.pathname==='/watch')id=u.searchParams.get('v')||'';
    if(u.hostname==='youtu.be')id=u.pathname.slice(1);
    if(['youtube.com','www.youtube.com'].includes(u.hostname)&&u.pathname.startsWith('/shorts/'))id=u.pathname.split('/')[2]||'';
    if(!/^[a-zA-Z0-9_-]{11}$/.test(id)) return '';
    return `<iframe title="Publireportage vidéo" loading="lazy" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  }catch{return '';}
}

const dayNames={MONDAY:'Lundi',TUESDAY:'Mardi',WEDNESDAY:'Mercredi',THURSDAY:'Jeudi',FRIDAY:'Vendredi',SATURDAY:'Samedi',SUNDAY:'Dimanche'};
const toHHMM=(t)=>t&&Number.isInteger(t.hours)?String(t.hours).padStart(2,'0')+':'+String(t.minutes||0).padStart(2,'0'):'';
function hoursHTML(h){
  const ps=h?.periods||[];
  if(!ps.length)return '<p class="muted">Consultez la fiche Google pour les horaires à jour.</p>';
  return `<dl class="hours-list">${Object.entries(dayNames).map(([day,label])=>{
    const match=ps.filter(p=>p.openDay===day);
    const ranges=match.map(p=>`${toHHMM(p.openTime)}–${toHHMM(p.closeTime)}${p.closeDay&&p.closeDay!==day?' (lendemain)':''}`);
    return `<div><dt>${label}</dt><dd>${ranges.length?ehtml(ranges.join(' · ')):'Fermé'}</dd></div>`;
  }).join('')}</dl><p class="muted">Les horaires spéciaux peuvent varier. Vérifiez sur Google avant votre visite.</p>`;
}
function socialHTML(socials, google, confirmed) {
  const labels={website:'Site officiel',facebook:'Facebook',instagram:'Instagram',linkedin:'LinkedIn',tiktok:'TikTok',youtube:'YouTube'};
  return `<div class="pd-links"><a class="btn-gold" href="${ehtml(google)}" target="_blank" rel="noopener noreferrer">${confirmed ? '📍 Fiche Google' : '⌕ Rechercher sur Google'}</a>${Object.entries(labels).map(([k,v])=>socials[k]?`<a class="btn-ghost" href="${ehtml(socials[k])}" target="_blank" rel="noopener noreferrer">${v}</a>`:'').join('')}</div>`;
}
function mapHTML(c, key) {
  if(!c.show_address)return '<p class="muted">Cette entreprise présente sa zone de service sans publier son adresse physique.</p>';
  if(c.google_place_id && key) {
    const src=`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=place_id:${encodeURIComponent(c.google_place_id)}`;
    return `<iframe title="Carte Google Maps de ${ehtml(c.business_name)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${ehtml(src)}"></iframe>`;
  }
  return `<p class="muted">Carte interactive à activer avec une clé Google Maps Embed autorisée pour ce domaine.</p><a class="btn-ghost" href="${ehtml(c.google_url)}" target="_blank" rel="noopener noreferrer">Afficher sur Google Maps ↗</a>`;
}
function profileHTML(c, key, baseURL) {
  const title=`${c.business_name} | ${c.category} à ${c.city} — Pont Digital`;
  const description=(c.advertorial_text||c.description||`${c.business_name} — ${c.category} à ${c.city}. Découvrez ses services, ses réalisations et ses coordonnées.`).slice(0,175);
  const canon=`${baseURL}/entreprise/${encodeURIComponent(c.id)}`;
  const otherLinks=[c.heyzine_url?`<a href="${ehtml(c.heyzine_url)}" target="_blank" rel="noopener noreferrer" class="btn-ghost">📖 Voir dans la revue</a>`:'', c.interview_video_url?`<a href="${ehtml(c.interview_video_url)}" target="_blank" rel="noopener noreferrer" class="btn-ghost">▶ Regarder la vidéo</a>`:''].join('');
  const jsonLd={"@context":"https://schema.org","@type":"LocalBusiness","name":c.business_name,"description":c.advertorial_text||c.description||'',"url":canon,"telephone":c.phone||undefined,"image":c.cover_photo_url||undefined,"areaServed":c.service_areas||c.city,"address":c.show_address?c.public_address:undefined,"sameAs":[c.google_url,...Object.values(c.social_links)].filter(Boolean)};
  const structured=JSON.stringify(jsonLd).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="fr-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${ehtml(title)}</title><meta name="description" content="${ehtml(description)}"><link rel="canonical" href="${ehtml(canon)}"><meta property="og:title" content="${ehtml(title)}"><meta property="og:description" content="${ehtml(description)}"><script type="application/ld+json">${structured}</script><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/index.css"><link rel="stylesheet" href="/css/repertoire.css"></head>
  <body><canvas id="starry-canvas" aria-hidden="true"></canvas><div class="aura"></div><header class="site-header"><a class="brand" href="/"><img src="/images/FavIcon.png" alt="Pont Digital"><span class="brand-name"><b>PONT DIGITAL</b><span>Le répertoire des entreprises d'ici</span></span></a><nav class="main-nav"><a href="/#revue">La revue</a><a href="/#repertoire">Répertoire</a><a href="/index2.html">Nos services</a></nav></header>
  <main class="page-wrap detail-page"><a class="back-link" href="/#repertoire">← Retour au répertoire</a>
  <section class="detail-hero"><div><span class="eyebrow">${ehtml(c.category)} · ${ehtml(c.city)}</span><h1 class="display">${ehtml(c.business_name)}</h1><p class="detail-lead">${ehtml(c.description || c.advertorial_text || 'Découvrez cette entreprise et les services qu’elle propose.')}</p>${c.google_rating!==null?`<span class="pd-rating">★ ${ehtml(c.google_rating.toFixed(1))}${c.google_review_count!==null?' · '+ehtml(c.google_review_count)+' avis':''} <small>Google</small></span>`:''}${socialHTML(c.social_links,c.google_url,Boolean(c.google_place_id))}</div>${c.cover_photo_url?`<img class="detail-cover" loading="lazy" src="${ehtml(c.cover_photo_url)}" alt="${ehtml(c.business_name)}">`:`<div class="detail-cover placeholder-cover">PONT DIGITAL</div>`}</section>
  <section class="detail-grid"><article class="glass-card"><h2 class="display">L'histoire de l'entreprise</h2><div class="narrative">${ehtml(c.advertorial_text||c.description||'Le portrait de cette entreprise sera ajouté prochainement.').replace(/\n/g,'<br>')}</div>${c.gallery.length?`<div class="gallery">${c.gallery.map(src=>`<img src="${ehtml(src)}" loading="lazy" alt="Réalisation de ${ehtml(c.business_name)}">`).join('')}</div>`:''}${videoEmbed(c.interview_video_url)?`<h3>Publireportage vidéo</h3><div class="media-frame">${videoEmbed(c.interview_video_url)}</div>`:''}<div class="pd-links">${otherLinks}</div></article>
  <aside class="detail-side"><section class="glass-card"><h2 class="display">Services &amp; territoire</h2><p>${ehtml(c.services||c.category)}</p><p class="muted">${ehtml(c.service_areas||c.city)}</p></section><section class="glass-card"><h2 class="display">Où nous trouver</h2>${c.show_address&&c.public_address?`<p>${ehtml(c.public_address)}</p>`:''}<div class="map-frame">${mapHTML(c,key)}</div><a href="${ehtml(c.google_url)}" target="_blank" rel="noopener noreferrer" class="btn-ghost">Itinéraire et fiche Google ↗</a></section><section class="glass-card"><h2 class="display">Horaires</h2>${hoursHTML(c.hours)}</section><section class="glass-card"><h2 class="display">Contact</h2>${c.phone?`<a class="btn-gold" href="tel:${ehtml(c.phone.replace(/[^+\d]/g,''))}">☎ ${ehtml(c.phone)}</a>`:'<p class="muted">Consultez la fiche Google pour contacter cette entreprise.</p>'}${socialHTML(c.social_links,c.google_url,Boolean(c.google_place_id))}</section></aside></section></main><footer class="site-footer">© 2026 Pont Digital · <a href="/">Revenir au répertoire</a></footer><script defer src="/js/starry-bg.js"></script></body></html>`;
}

export async function handleDirectoryPublic(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if(!env.DB) return qjson({ok:false,error:'La base de données n’est pas connectée.'},503);
    if (path==='/api/public/clients' && request.method==='GET') {
      const {results=[]}=await env.DB.prepare(`SELECT ${CLIENT_COLUMNS} FROM clients WHERE ${ACTIVE} ORDER BY created_at DESC LIMIT 2000`).all();
      return qjson({ok:true,clients:results.map(publicClient)});
    }
    if (path==='/api/public/municipalities' && request.method==='GET') {
      return qjson({ok:true,...await quebecCities(env)});
    }
    if (path==='/api/public/magazines' && request.method==='GET') {
      let issues=[];
      try {({results:issues=[]}=await env.DB.prepare('SELECT issue_month,title,heyzine_url,cover_url,introduction FROM magazine_issues WHERE published=1 ORDER BY issue_month DESC LIMIT 72').all());}
      catch(e){ /* ancien deploiement sans migration: edition non publiee plutot que casser la vitrine */ }
      return qjson({ok:true,issues:issues.map(i=>({...i,heyzine_url:surl(i.heyzine_url),cover_url:surl(i.cover_url)}))});
    }
    const m=path.match(/^\/entreprise\/(\d+)$/);
    if(m&&request.method==='GET'){
      const row=await env.DB.prepare(`SELECT ${CLIENT_COLUMNS} FROM clients WHERE id=? AND ${ACTIVE}`).bind(Number(m[1])).first();
      if(!row)return new Response('Entreprise introuvable ou non publiée',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
      const html=profileHTML(publicClient(row),env.MAPS_EMBED_API_KEY||'',url.origin);
      return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'}});
    }
    return qjson({ok:false,error:'Ressource introuvable'},404);
  }catch(e){
    return qjson({ok:false,error:'Le répertoire est momentanément indisponible.'},503);
  }
}
