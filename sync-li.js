/**
 * Sync bordados da Loja Integrada → Dra Charm app
 * Carregado pelo bookmarklet. Roda na página do painel LI (mesma origem, cookies OK).
 * Lê a lista de pedidos + detalhe de cada um, filtra os com bordado, envia via postMessage pro app.
 */
(function(){
  const APP_ORIGIN = document.currentScript?.dataset?.appOrigin || 'https://producao-dra-charm.vercel.app';
  const SKU_LOGOMARCA = 'U4UDXDTVP';
  const SKU_PERSONALIZACAO = 'QGH2F6NFR';

  // ==================== UI de progresso ====================
  const oldPanel = document.getElementById('drachrm-sync-panel');
  if (oldPanel) oldPanel.remove();
  const panel = document.createElement('div');
  panel.id = 'drachrm-sync-panel';
  panel.style.cssText = 'position:fixed;top:20px;right:20px;background:#fff;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:16px 20px;z-index:2147483647;font-family:sans-serif;font-size:14px;min-width:280px;max-width:380px;color:#000';
  panel.innerHTML = '<div style="font-weight:bold;color:#f59e0b;margin-bottom:8px">🧵 Sync Dra Charm</div><div id="drachrm-sync-status">Iniciando...</div><div id="drachrm-sync-progress" style="margin-top:8px;height:6px;background:#eee;border-radius:3px;overflow:hidden"><div id="drachrm-sync-bar" style="width:0%;height:100%;background:#f59e0b;transition:width .2s"></div></div>';
  document.body.appendChild(panel);
  const setStatus = (t) => { document.getElementById('drachrm-sync-status').textContent = t; };
  const setProgress = (pct) => { document.getElementById('drachrm-sync-bar').style.width = pct + '%'; };

  // ==================== Descobre paginação e coleta TODOS os IDs ====================
  function collectIdsFromDoc(doc){
    return [...new Set(
      Array.from(doc.querySelectorAll('a[href*="/painel/pedido/"]'))
        .map(a => a.href.match(/pedido\/(\d+)/)?.[1])
        .filter(Boolean)
    )];
  }
  const currentUrl = new URL(window.location.href);
  const dateStart = currentUrl.searchParams.get('data_inicio');
  const dateEnd = currentUrl.searchParams.get('data_fim');
  if (!dateStart){
    setStatus('❌ Abra pelo botão "Sincronizar" no app (URL precisa ter ?data_inicio=... na aba do LI).');
    return;
  }
  const totalMatch = document.body.innerText.match(/Mostrando\s+\d+\s+de\s+(\d+)/i);
  const totalCount = totalMatch ? parseInt(totalMatch[1]) : 50;
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  setStatus(`Total ${totalCount} pedidos em ${totalPages} página(s). Coletando IDs...`);

  const allIds = collectIdsFromDoc(document);
  // Busca páginas 2..N
  for (let p = 2; p <= totalPages; p++){
    setStatus(`Coletando IDs da página ${p}/${totalPages}...`);
    setProgress(Math.round((p/totalPages)*30));
    try {
      // LI usa PATH pra paginar: /painel/pedido/listar/pagina/N
      const pageUrl = `${currentUrl.origin}/painel/pedido/listar/pagina/${p}?data_inicio=${encodeURIComponent(dateStart)}&data_fim=${encodeURIComponent(dateEnd)}`;
      const html = await fetch(pageUrl, {credentials:'include'}).then(r => r.text());
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ids = collectIdsFromDoc(doc);
      for (const id of ids) if (!allIds.includes(id)) allIds.push(id);
    } catch(e){}
  }
  const orderIds = allIds;
  if (orderIds.length === 0){
    setStatus('❌ Nenhum pedido encontrado nesta data.');
    setTimeout(() => panel.remove(), 5000);
    return;
  }
  setStatus(`Encontrei ${orderIds.length} pedidos. Analisando um a um...`);

  // ==================== Parse do detalhe do pedido ====================
  function parseOrderDetail(html, orderId){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const txt = doc.body.innerText;
    const skus = [...txt.matchAll(/SKU:\s*([^\n]+)/g)].map(m=>m[1].trim());
    const hasLogo = skus.includes(SKU_LOGOMARCA);
    const hasPerso = skus.includes(SKU_PERSONALIZACAO);
    if (!hasLogo && !hasPerso) return null;

    // Cliente (procura "Pedido efetuado" ou "(cliente)")
    const clienteMatch = txt.match(/([A-Z][A-Za-zÀ-ÿ' ]+)\s*\(cliente\)/);
    const cliente = clienteMatch ? clienteMatch[1].trim() : '';

    // Personalização (bloco padrão da LI)
    const personaMatch = txt.match(/Personalização de produtos:?([\s\S]{0,3000}?)(?=\n\n[A-Z]|Pagamento via|$)/);
    const persoBlock = personaMatch ? personaMatch[1] : '';
    const fields = {};
    for (const m of persoBlock.matchAll(/--\s*([^:]+):\s*([^\n]+)/g)){
      const k = m[1].trim().toLowerCase(), v = m[2].trim();
      fields[k] = v;
    }
    // Cores: "#hex-Nome"
    let corHex = null, corNome = null;
    if (fields['cores']){
      const cm = fields['cores'].match(/^(#[0-9a-fA-F]{3,8})-(.+)$/);
      if (cm){ corHex = cm[1]; corNome = cm[2].trim(); }
      else { corNome = fields['cores']; }
    }
    // Imagem
    let imgUrl = null;
    if (fields['fazer upload da imagem']) imgUrl = fields['fazer upload da imagem'];
    else {
      const imgM = persoBlock.match(/https?:\/\/[^\s\n]+\.(?:jpg|jpeg|png|pdf|svg|gif)/i);
      if (imgM) imgUrl = imgM[0];
    }

    let tipo = null;
    if (hasLogo && hasPerso) tipo = 'ambos';
    else if (hasLogo) tipo = 'logomarca';
    else if (hasPerso) tipo = 'nome_profissao';

    return {
      pedido_numero: orderId,
      pedido_cliente: cliente,
      pedido_url: `https://app.lojaintegrada.com.br/painel/pedido/${orderId}/detalhar`,
      bordado_tipo: tipo,
      bordado_linha1: fields['linha 1*'] || fields['linha 1'] || null,
      bordado_linha2: fields['linha 2*'] || fields['linha 2'] || null,
      bordado_cor_hex: corHex,
      bordado_cor_nome: corNome,
      bordado_fonte: fields['tipo de letra'] || null,
      bordado_lado: fields['lados'] || fields['lado'] || null,
      bordado_imagem_url: imgUrl,
    };
  }

  // ==================== Fetch em paralelo (4 por vez) ====================
  (async () => {
    const results = [];
    let done = 0;
    const CONCURRENCY = 4;
    for (let i=0; i<orderIds.length; i += CONCURRENCY){
      const batch = orderIds.slice(i, i+CONCURRENCY);
      const parsed = await Promise.all(batch.map(async id => {
        try {
          const r = await fetch(`https://app.lojaintegrada.com.br/painel/pedido/${id}/detalhar`, {credentials:'include'});
          const html = await r.text();
          return parseOrderDetail(html, id);
        } catch (e){ return null; }
      }));
      for (const p of parsed){ if (p) results.push(p); }
      done += batch.length;
      setStatus(`Analisando ${done}/${orderIds.length} pedidos... (${results.length} com bordado até agora)`);
      setProgress(Math.round((done/orderIds.length)*100));
    }

    if (results.length === 0){
      setStatus('✓ Analisei tudo. Nenhum pedido com bordado nesta data.');
      setTimeout(() => panel.remove(), 5000);
      return;
    }
    setStatus(`Enviando ${results.length} pedidos com bordado pro app Dra Charm...`);
    if (!window.opener){
      setStatus('❌ Esta aba não foi aberta pelo botão "Sincronizar" no app. Abre pelo app.');
      return;
    }
    window.opener.postMessage({type:'draCharmBordados', orders: results}, APP_ORIGIN);
    setStatus(`✅ ${results.length} pedidos enviados! Volta pra aba do Dra Charm — os cards já estão lá.`);
    setTimeout(() => panel.remove(), 8000);
  })();
})();
