// Fallback para t() caso admin-i18n.js não esteja carregado ainda
if (typeof t === "undefined") {
  window.t = function (key, fallback) {
    return fallback || key;
  };
}

// =========================================
// 1. CONSTANTES E INICIALIZAÇÃO
// =========================================
// ── Globals carregados do banco (configuracoes) ──────────────────
let TAXA_MOTOBOY = 0; // taxa_motoboy_base
let AJUDA_COMBUSTIVEL = 0; // ajuda_combustivel
let COORD_LOJA = { lat: 0, lng: 0 }; // coord_lat / coord_lng
let CHAVE_PIX_CFG = ""; // chave_pix
let NOME_PIX_CFG = ""; // nome_pix
let DADOS_ALIAS_CFG = ""; // dados_alias
let QR_PY_URL = ""; // URL do QR Paraguay
let NOME_ALIAS_CFG = ""; // nome_alias
let WHATSAPP_LOJA_CFG = ""; // whatsapp_loja (dígitos)
let NOME_RESTAURANTE = ""; // nome_restaurante
let FEATURES_ATIVAS = null; // features_ativas JSONB
let PERMISSOES_USUARIO = null; // perfis_acesso.permissoes_customizadas do usuário logado — sobrepõe FEATURES_ATIVAS quando definido
let TABELA_FRETE_ADMIN = null; // tabela_frete (carregada do banco para calcularFretePDV)

let perfilUsuario = null;
let _perfilId = null; // UUID do usuário logado
let _perfilNome = null; // nome_display do usuário logado
let audioHabilitado = false; // Controle de permissão do navegador

const ADMIN_APP_VERSION = "2026-04-17-v1";
const ADMIN_APP_STORAGE_KEYS = [
  "app_lastTab",
  "app_lastSubTab",
  "app_pdv_aba",
  "app_sidebar_collapsed",
];

function resetAdminStorageOnVersionChange() {
  const storedVersion = localStorage.getItem("admin_app_version");
  if (storedVersion !== ADMIN_APP_VERSION) {
    ADMIN_APP_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    localStorage.setItem("admin_app_version", ADMIN_APP_VERSION);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  resetAdminStorageOnVersionChange();
  // Recupera a última aba — mas só restaura depois do auth carregar
  // Para não disparar alert('Acesso restrito') antes de perfilUsuario estar definido,
  // começa sempre no dashboard e restaura a aba real após o login
  let lastTab = localStorage.getItem("app_lastTab");
  const _restrictedTabs = [
    "inventario",
    "financeiro",
    "adminmaster",
    "estatisticas",
    "ficha-tecnica",
    "crm",
  ];
  if (
    !lastTab ||
    !document.getElementById(lastTab) ||
    _restrictedTabs.includes(lastTab)
  ) {
    lastTab = "dashboard";
  }
  showTab(lastTab);

  // Timeout de segurança: se o overlay travar por mais de 8s, remove forçado
  setTimeout(() => {
    const overlay = document.getElementById("auth-overlay");
    if (overlay) {
      console.warn("⏰ Timeout de auth — removendo overlay forçado");
      overlay.remove();
      // Se perfilUsuario ainda não carregou, define padrão para não travar o painel
      if (!perfilUsuario) perfilUsuario = "dono";
    }
  }, 8000);

  // Inicia Monitoramento Realtime
  iniciarRealtime();

  // === SISTEMA DE AUTO-REFRESH (10 SEGUNDOS) ===
  // Backup caso o Realtime falhe
  setInterval(() => {
    const abaAtual = localStorage.getItem("app_lastTab");
    // true = modo silencioso (sem recarregar som se já estiver tocando)
    if (abaAtual === "pedidos") carregarPedidos(true);
    if (abaAtual === "cozinha") carregarCozinha();
    if (abaAtual === "pdv") carregarMonitorMesas();
    // if (abaAtual === 'financeiro') calcularFinanceiro();
    if (abaAtual === "dashboard") carregarDashboard();
  }, 60000);

  // Verifica Login e Permissões
  if (typeof checkUser === "function") {
    let session;
    try {
      session = await checkUser();
    } catch (e) {
      window.location.href = "login.html";
      return;
    }
    if (!session) return; // checkUser já redirecionou

    // Verifica se o usuário aceitou o contrato de serviços
    await verificarContratoAdmin(session);

    // Remove overlay IMEDIATAMENTE após sessão confirmada
    const overlay = document.getElementById("auth-overlay");
    if (overlay) overlay.remove();

    const { data: perfil } = await supa
      .from("perfis_acesso")
      .select("cargo, nome_display, permissoes_customizadas")
      .eq("id", session.user.id)
      .single();

    _perfilId = session.user.id;
    _perfilNome = perfil?.nome_display || session.user.email || "Admin";
    perfilUsuario = perfil ? perfil.cargo : "dono";
    PERMISSOES_USUARIO = perfil?.permissoes_customizadas || null;

    // Atualiza sidebar: nome, cargo e email
    const elNomeDisplay = document.getElementById("user-nome-display");
    const elCargo = document.getElementById("user-cargo");
    const elEmail = document.getElementById("user-email");
    if (elNomeDisplay) elNomeDisplay.textContent = _perfilNome;
    if (elEmail) elEmail.textContent = session.user.email;

    const cargoBadges = {
      adminMaster: "🎮 ADMIN MASTER",
      dono: "🔑 DONO",
      gerente: "👔 GERENTE",
      funcionario: "👷 FUNCIONÁRIO",
      garcom: "🍽️ GARÇOM",
    };
    if (elCargo)
      elCargo.textContent =
        cargoBadges[perfilUsuario] || perfilUsuario.toUpperCase();

    // Carrega features e aplica visibilidade das abas
    await _carregarFeaturesGlobais();

    // Atualiza brand com nome do restaurante (carregado em _carregarFeaturesGlobais)
    const elBrand = document.getElementById("brand-text");
    if (elBrand) elBrand.textContent = (NOME_RESTAURANTE || "ADMIN") + " ADMIN";

    _aplicarVisibilidadeAbas();

    if (perfilUsuario === "adminMaster") {
      // adminMaster vê tudo + aba exclusiva de administração
      document
        .querySelectorAll(".menu-item")
        .forEach((m) => (m.style.display = "flex"));
      const menuAM = document.getElementById("menu-adminmaster");
      if (menuAM) menuAM.style.display = "flex";
      const menuFil = document.getElementById("menu-filiais");
      if (menuFil) menuFil.style.display = "flex";
      // Exibe opção Dono no select de equipe
      const optDono = document.getElementById("opt-cargo-dono");
      if (optDono) optDono.style.display = "";
    }
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "adminMaster" ||
      perfilUsuario === "gerente"
    ) {
      const menuFin = document.getElementById("menu-financeiro");
      if (menuFin) menuFin.style.display = "flex";
    }
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "gerente" ||
      perfilUsuario === "adminMaster"
    ) {
      const menuEst = document.getElementById("menu-inventario");
      if (menuEst) menuEst.style.display = "flex";
    }

    // ── Mostrar menus novos para dono/gerente/adminMaster ──
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "gerente" ||
      perfilUsuario === "adminMaster"
    ) {
      [
        "menu-estatisticas",
        "menu-ficha-tecnica",
        "menu-crm",
        "menu-mensalistas",
      ].forEach((id) => {
        const m = document.getElementById(id);
        if (m) m.style.display = "flex";
      });
    }

    carregarDashboard();
    carregarMotoboysSelect();

    // ── Controle de Assinatura (barra de aviso / bloqueio) ──
    if (typeof SubscriptionUI !== "undefined") {
      SubscriptionUI.inicializar({
        supabaseUrl: typeof _SUPABASE_URL !== "undefined" ? _SUPABASE_URL : "",
        supabaseKey: typeof _SUPABASE_KEY !== "undefined" ? _SUPABASE_KEY : "",
        contatoFone: "595976771714",
        contatoNome: "SuporteLinkPY",
      });
    }

    // Exibe menu Assinatura somente para adminMaster
    const menuAssin = document.getElementById("menu-assinatura");
    if (menuAssin)
      menuAssin.style.display =
        perfilUsuario === "adminMaster" ? "flex" : "none";
  }

  let _lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth !== _lastWidth) {
      _lastWidth = window.innerWidth;
      if (document.getElementById("pdv")?.classList.contains("active")) {
        pdvIniciarTabs();
      }
    }
  });

  const pagSelect = document.getElementById('balcao-pag');
  if (pagSelect && !document.getElementById('pdv-cliente-nota-container')) {
    const container = document.createElement('div');
    container.id = 'pdv-cliente-nota-container';
    container.style.display = 'none';
    container.style.marginTop = '12px';
    container.style.marginBottom = '8px';
    container.style.background = '#f8fafc';
    container.style.padding = '12px';
    container.style.borderRadius = '10px';
    container.style.border = '1px solid #e2e8f0';
    container.innerHTML = `
      <label style="display: block; font-size: 0.8rem; font-weight: 600; margin-bottom: 6px; color: #1e293b;">📋 Cliente (para Nota)</label>
      <div style="display: flex; gap: 6px; align-items: center; position: relative;">
        <div style="flex: 1; position: relative;">
          <input id="pdv-cliente-busca" type="text" name="pdv_busca_cliente_nota_xk9"
                 placeholder="Buscar por nome ou telefone"
                 autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                 data-lpignore="true" data-form-type="other"
                 style="width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1.5px solid #e0e0e0; border-radius: 8px; font-size: 0.9rem;"
                 oninput="pdvFiltrarClienteDropdown(this)"
                 onfocus="pdvMostrarClienteDropdown(this)"
                 onblur="pdvEsconderClienteDropdown()">
          <div id="pdv-cliente-dropdown"
               style="display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; max-height:220px; overflow-y:auto;
                      background:#fff; border:1px solid #e2e8f0; border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,0.12); z-index:9999;">
          </div>
        </div>
        <button type="button" onclick="pdvAbrirCadastroCliente()"
                style="padding: 8px 14px; background: #3498db; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; white-space: nowrap;">
          + Novo
        </button>
      </div>
      <div style="font-size: 0.72rem; color: #888; margin-top: 4px;">Clique ou digite para buscar entre os clientes cadastrados</div>
    `;
    // Insere logo após o select de pagamento
    pagSelect.parentNode.insertBefore(container, pagSelect.nextSibling);
  }
  // Carrega clientes e ajusta visibilidade inicial
  pdvCarregarClientes();
  pdvAtualizarClienteNota();
  initMensalistas()

  // === DESBLOQUEIO DE SOM — AudioContext (sem AbortError) ===
  // play().then(pause()) SEMPRE gera AbortError no Chrome. Usamos buffer silencioso.
  document.body.addEventListener(
    "click",
    () => {
      if (!audioHabilitado) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const buf = ctx.createBuffer(
            1,
            ctx.sampleRate * 0.001,
            ctx.sampleRate,
          );
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
          src.onended = () => {
            audioHabilitado = true;
            ctx.close();
          };
        } catch (e) {
          audioHabilitado = true;
        }
      }
    },
    { once: true },
  );
});

// selecionarTipo do Gemini removido — o sistema usa selecionarTipoBuilder() abaixo

// =========================================
// CLOUDINARY — UPLOAD UTILITÁRIO
// =========================================
const CLOUDINARY_CLOUD_NAME = "dsxwnbj0o";
const CLOUDINARY_UPLOAD_PRESET = "ml_default";
const CLOUDINARY_ENDPOINT = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

// Diagnóstico: rode testarCloudinary() no console do navegador para verificar se o preset está OK
window.testarCloudinary = async function () {
  // Cria um pixel 1x1 PNG mínimo para testar o upload
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const blob = await fetch(pixel).then((r) => r.blob());
  const file = new File([blob], "test.png", { type: "image/png" });
  try {
    const url = await uploadImageToImgbb(file);
    console.log("✅ Cloudinary OK! URL de teste:", url);
    alert("✅ Cloudinary funcionando!\nURL: " + url);
  } catch (e) {
    console.error("❌ Cloudinary ERRO:", e.message);
    alert("❌ Cloudinary com problema:\n\n" + e.message);
  }
};

// ========================================
// IMGBB UPLOAD
// ========================================
const IMGBB_API_KEY = "d6ade30e77d706a440f7c03f08af33c4"; // Substitua pela sua chave

/**
 * Faz upload de uma imagem para o ImgBB e retorna a URL direta.
 * @param {File} file - Arquivo de imagem
 * @param {number} quality - Qualidade WebP (0-100), padrão 80
 * @returns {Promise<string>} - URL da imagem
 */
async function uploadImageToImgbb(file, quality = 80) {
  // 1. Validações
  const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!tiposPermitidos.includes(file.type)) {
    throw new Error('Formato inválido. Use JPG, PNG, WEBP ou GIF.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Imagem muito grande. Máximo 10MB (limite do ImgBB).');
  }

  // 2. Converter para WebP (comprime e reduz tamanho)
  const webpBlob = await convertToWebP(file, quality);

  // 3. Enviar para ImgBB via API
  const formData = new FormData();
  formData.append('key', IMGBB_API_KEY);
  formData.append('image', webpBlob, 'image.webp'); // Envia como Blob
  formData.append('name', file.name.replace(/\.[^.]+$/, '.webp'));

  const response = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();
  if (!data.success) {
    throw new Error(`ImgBB: ${data.error?.message || 'Erro desconhecido'}`);
  }

  // Retorna a URL direta da imagem (display_url)
  return data.data.url;
}

/**
 * Converte um File/Blob para WebP com qualidade ajustável.
 */
function convertToWebP(file, quality = 80) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Falha na conversão para WebP'));
        }, 'image/webp', quality / 100);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =========================================
// 2. CONTROLE DE ABAS
// =========================================
function showTab(tabId, event) {
  console.log("Tentando abrir aba:", tabId);
  console.log("Event:", event);

  // 1. O 'de-para' para garantir que IDs como 'categorias' ou 'motoboys'
  // abram a aba pai correta no seu novo HTML
  let realTabId = tabId;
  if (tabId === "categorias" || tabId === "motoboys") {
    realTabId = "produtos";
  }

  let target = document.getElementById(realTabId);
  if (!target) {
    console.log("Target not found for", realTabId);
    target = document.getElementById("pedidos");
    realTabId = "pedidos";
  } else {
    console.log("Target found:", target);
  }

  localStorage.setItem("app_lastTab", realTabId);

  // 2. Reset visual
  document.querySelectorAll(".tab-content").forEach((t) => {
    t.classList.remove("active");
    t.style.display = "none";
  });
  document
    .querySelectorAll(".menu-item")
    .forEach((m) => m.classList.remove("active"));

  // 3. Ativa a aba pai
  target.classList.add("active");
  target.style.display = "block";
  console.log("Added active class to", realTabId);

  // 4. Ativa o botão no menu lateral
  if (event && event.currentTarget) {
    event.currentTarget.classList.add("active");
  } else {
    // Restaura highlight ao carregar página (sem evento de clique)
    document.querySelectorAll(".menu-item").forEach((m) => {
      const oc = m.getAttribute("onclick") || "";
      if (oc.includes(`'${realTabId}'`) || oc.includes(`'${tabId}'`)) {
        m.classList.add("active");
      }
    });
  }

  // 5. PULO DO GATO: Se a aba for produtos, categorias ou motoboys,
  // precisamos ativar a SUB-ABA correspondente
  if (realTabId === "produtos") {
    console.log("Calling showSubTab for produtos");
    if (tabId === "categorias") showSubTab("lista-categorias-wrapper");
    else if (tabId === "motoboys") showSubTab("lista-motos-wrapper");
    else {
      // Clique direto em "Produtos": sempre abre a lista de produtos,
      // ignorando qualquer sub-aba salva de navegação anterior (ex: Categorias).
      showSubTab("lista-produtos-wrapper");
    }
  }

  if (realTabId === 'mensalistas') {
    if (typeof initMensalistas === 'function') initMensalistas();
  }
  if (realTabId === 'notas') {
    // Força o carregamento da lista com um pequeno delay para garantir que a DOM já foi atualizada
    const loading = document.getElementById('notas-loading');
    if (loading) loading.style.display = 'flex';
    if (typeof notasCarregar === 'function') {
      setTimeout(async () => {
        await notasCarregar();
        if (loading) loading.style.display = 'none';
      }, 50);
    } else if (typeof notasInicializar === 'function') {
      notasInicializar(); // fallback
    }
  }
  if (realTabId === 'facturacion') {
    if (typeof initFacturacion === 'function') initFacturacion();
  }

  // 6. Carregamento de dados
  if (realTabId === "pedidos") {
    carregarPedidos();
    carregarStatusDelivery();
  }
  if (realTabId === "cozinha") carregarCozinha();
  if (realTabId === "financeiro") calcularFinanceiro();
  if (realTabId === "dashboard") carregarDashboard();
  if (realTabId === "pdv") carregarPDV();
  if (realTabId === "equipe") carregarEquipe();
  if (realTabId === "adminmaster") {
    amCarregarUsuarios();
    renderPainelFeatures();
  }
  if (realTabId === "assinatura") carregarPainelAssinatura();
  if (realTabId === "estatisticas") {
    initEstatisticas();
    _estPopularCategorias();
  }
  if (realTabId === "ficha-tecnica") {
    initFichaTecnica();
  }
  if (realTabId === "crm") {
    initCRM();
  }
  if (realTabId === "filiais") {
    initFiliais();
  }
  if (realTabId === "mensalistas") {
    initMensalistas();
  }
  if (realTabId === "estoque") {
    veRenderizarPainelEstoque();
  }
  if (realTabId === "configuracoes") {
    carregarConfiguracoes();
    if (perfilUsuario === "dono" || perfilUsuario === "gerente") {
      carregarCupons();
    }
  }
  if (realTabId === "inventario") {
    if (!perfilUsuario) return; // auth not loaded yet — wait
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "gerente" ||
      perfilUsuario === "adminMaster"
    )
      carregarInventario();
    else {
      alert("Acesso restrito.");
      showTab("pedidos", null);
    }
  }
}

const SUBTABS_VALIDAS = [
  "lista-produtos-wrapper",
  "lista-categorias-wrapper",
  "lista-motos-wrapper",
];

function showSubTab(subId) {
  console.log("Alternando para sub-aba:", subId);

  if (!SUBTABS_VALIDAS.includes(subId)) {
    subId = "lista-produtos-wrapper";
  }

  localStorage.setItem("app_lastSubTab", subId);

  // 1. Seleciona todas as sub-abas e esconde TODAS
  const subtabs = document.querySelectorAll(".subtab-content");
  console.log("Hiding all subtabs, found:", subtabs.length);
  subtabs.forEach((tab) => {
    tab.style.display = "none";
  });

  // 2. Mostra apenas a que foi clicada
  const target = document.getElementById(subId);
  if (target) {
    console.log("Showing subtab:", subId);
    target.style.display = "block";
  } else {
    console.log("Subtab not found:", subId);
  }

  // 3. Carrega os dados específicos
  if (subId === "lista-produtos-wrapper") carregarProdutos();
  if (subId === "lista-categorias-wrapper") carregarCategorias();
  if (subId === "lista-motos-wrapper") carregarMotoboys();
}

// =========================================
// 3. REALTIME E ALARME (LOOP)
// =========================================
// ── Features globais (controladas pelo adminMaster) ────────────
async function _carregarFeaturesGlobais() {
  const { data } = await supa
    .from("configuracoes")
    .select(
      "features_ativas, nome_restaurante, whatsapp_loja, coord_lat, coord_lng, taxa_motoboy_base, ajuda_combustivel, chave_pix, nome_pix, dados_alias, nome_alias, tabela_frete",
    )
    .maybeSingle();
  if (!data) return;
  FEATURES_ATIVAS = data.features_ativas || null;
  // Globals operacionais
  if (data.nome_restaurante) NOME_RESTAURANTE = data.nome_restaurante;
  if (data.whatsapp_loja) WHATSAPP_LOJA_CFG = data.whatsapp_loja;
  if (data.coord_lat) COORD_LOJA.lat = parseFloat(data.coord_lat);
  if (data.coord_lng) COORD_LOJA.lng = parseFloat(data.coord_lng);
  if (data.taxa_motoboy_base != null) TAXA_MOTOBOY = data.taxa_motoboy_base;
  if (data.ajuda_combustivel != null)
    AJUDA_COMBUSTIVEL = data.ajuda_combustivel;
  if (data.chave_pix) CHAVE_PIX_CFG = data.chave_pix;
  if (data.nome_pix) NOME_PIX_CFG = data.nome_pix;
  if (data.dados_alias) DADOS_ALIAS_CFG = data.dados_alias;
  if (data.nome_alias) NOME_ALIAS_CFG = data.nome_alias;
  if (data.tabela_frete && Array.isArray(data.tabela_frete))
    TABELA_FRETE_ADMIN = data.tabela_frete;
}

// ── Filtra formas de pagamento no PDV conforme features_ativas.pagamentos ──────
function _aplicarFormasPagamentoPDV(features) {
  const pags = features?.pagamentos;
  const select = document.getElementById("balcao-pag");
  if (!select) return;
  Array.from(select.options).forEach((opt) => {
    if (!opt.value) return;
    if (!pags) {
      opt.style.display = "";
      return;
    }
    if (pags[opt.value] === false) {
      opt.style.display = "none";
      // Se a opção oculta estava selecionada, reset para Efetivo
      if (select.value === opt.value) select.value = "Efetivo";
    } else {
      opt.style.display = "";
    }
  });
}

function _feat(categoria, chave) {
  // 1. Permissão individual do usuário logado (se definida) tem
  //    prioridade sobre o padrão global — permite ao Admin Master
  //    liberar/restringir uma aba ou função para uma pessoa específica.
  const permIndiv = PERMISSOES_USUARIO?.[categoria];
  if (permIndiv && Object.prototype.hasOwnProperty.call(permIndiv, chave)) {
    return permIndiv[chave] !== false;
  }
  // 2. Padrão global (Configurações > Features)
  if (!FEATURES_ATIVAS) return true; // sem config = tudo ativo
  const cat = FEATURES_ATIVAS[categoria];
  if (!cat) return true;
  return cat[chave] !== false;
}

function _aplicarVisibilidadeAbas() {
  const mapa = {
    "menu-pedidos": "pedidos",
    "menu-cozinha": "cozinha",
    "menu-pdv": "pdv",
    "menu-financeiro": "financeiro",
    "menu-inventario": "inventario",
    "menu-equipe": "equipe",
    "menu-configuracoes": "configuracoes",
    "menu-dashboard": "dashboard",
    "menu-estatisticas": "estatisticas",
    "menu-ficha-tecnica": "ficha-tecnica",
    "menu-crm": "crm",
    "menu-turnos": "turnos",
    "menu-produtos": "produtos",
    "menu-notas": "notas",
  };
  // Só aplica restrições para cargos abaixo de adminMaster
  if (perfilUsuario === "adminMaster") return;
  Object.entries(mapa).forEach(([menuId, chave]) => {
    const el = document.getElementById(menuId);
    // Um item começa visível se: (a) já estava visível por padrão, ou
    // (b) o cargo do usuário o revela mais abaixo (dono/gerente/etc).
    // Aqui só cuidamos de ESCONDER quando a permissão nega — nunca de
    // revelar (isso é feito pelos blocos de cargo/permissão específicos).
    if (el && !_feat("tabs", chave)) el.style.display = "none";
  });
}

// Salva features (adminMaster only)
async function salvarFeatures() {
  if (perfilUsuario !== "adminMaster") return alert(t("alert.acesso_negado"));
  const tabs = {},
    tipos = {},
    funcs = {};
  document.querySelectorAll("[data-feat-tab]").forEach((el) => {
    tabs[el.dataset.featTab] = el.checked;
  });
  document.querySelectorAll("[data-feat-tipo]").forEach((el) => {
    tipos[el.dataset.featTipo] = el.checked;
  });
  document.querySelectorAll("[data-feat-func]").forEach((el) => {
    funcs[el.dataset.featFunc] = el.checked;
  });
  const pagamentos = {};
  document.querySelectorAll("[data-feat-pag]").forEach((el) => {
    pagamentos[el.dataset.featPag] = el.checked;
  });
  const features = {
    tabs,
    tipos_produto: tipos,
    funcionalidades: funcs,
    pagamentos,
  };
  const { error } = await supa
    .from("configuracoes")
    .update({ features_ativas: features })
    .gt("id", 0);
  if (error) return alert("Erro: " + error.message);
  FEATURES_ATIVAS = features;
  alert(t("alert.features_salvas"));
}

// Renderiza painel de features (adminMaster)
async function renderPainelFeatures() {
  const targets = ["painel-features", "painel-features-master"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!targets.length) return;
  await _carregarFeaturesGlobais();
  const f = FEATURES_ATIVAS || {};
  const tabs = f.tabs || {};
  const tipos = f.tipos_produto || {};
  const funcs = f.funcionalidades || {};

  const chkTabs = [
    ["pedidos", "Pedidos"],
    ["cozinha", "Cozinha/KDS"],
    ["pdv", "PDV Balcão"],
    ["financeiro", "Financeiro"],
    ["inventario", "Inventário"],
    ["equipe", "Equipe"],
    ["configuracoes", "Configurações"],
    ["dashboard", "Dashboard"],
    ["turnos", "Painel Turnos/TV"],
    ["notas", "Na Nota (Contas de Clientes)"],
  ]
    .map(
      ([
        k,
        l,
      ]) => `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
    <input type="checkbox" data-feat-tab="${k}" ${tabs[k] !== false ? "checked" : ""} style="width:18px;height:18px">
    <span>${l}</span></label>`,
    )
    .join("");

  const chkTipos = [
    ["padrao", "Simples"],
    ["bebida", "Bebida"],
    ["lanche", "Lanche"],
    ["pizza", "Pizza"],
    ["acai", "Açaí"],
    ["shake", "Shake"],
    ["suco", "Suco"],
    ["sorvete", "Sorvete"],
    ["montavel", "Montável"],
    ["combo", "Combo"],
    ["variacoes", "Variações"],
    ["kg", "⚖️ Venda Kg"],
  ]
    .map(
      ([
        k,
        l,
      ]) => `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
    <input type="checkbox" data-feat-tipo="${k}" ${tipos[k] !== false ? "checked" : ""} style="width:18px;height:18px">
    <span>${l}</span></label>`,
    )
    .join("");

  const chkFuncs = [
    ["delivery", "Delivery"],
    ["retirada", "Retirada"],
    ["local", "Comer no Local"],
    ["balcao", "Balcão/PDV"],
    ["cupons", "Cupons"],
    ["factura", "Factura"],
    ["multipagamento", "Multipagamento"],
    ["agendamento", "Agendamento"],
  ]
    .map(
      ([
        k,
        l,
      ]) => `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
    <input type="checkbox" data-feat-func="${k}" ${funcs[k] !== false ? "checked" : ""} style="width:18px;height:18px">
    <span>${l}</span></label>`,
    )
    .join("");

  const pags = f.pagamentos || {};
  const chkPags = [
    ["Efetivo", "💵 Efectivo/Dinheiro"],
    ["Cartao", "💳 Tarjeta PY"],
    ["CartaoBR", "💳🇧🇷 Cartão Brasileiro (R$)"],
    ["Pix", "🟢 Pix (BR)"],
    ["Transferencia", "🏦 Alias/Transferência PY"],
    ["QrPy", "📱 QR Paraguay"],
    ["Multipagamento", "🔀 Dividir Pagamento"],
  ]
    .map(
      ([k, l]) =>
        `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
      <input type="checkbox" data-feat-pag="${k}" ${pags[k] !== false ? "checked" : ""} style="width:18px;height:18px">
      <span>${l}</span></label>`,
    )
    .join("");

  const html = `
    <div style="display:grid;gap:20px">
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">📂 Abas visíveis</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">${chkTabs}</div>
      </div>
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">💳 Formas de Pagamento</h4>
        <p style="font-size:0.8rem;color:#888;margin-bottom:8px">Controla o que aparece no app do cliente <strong>e</strong> no PDV</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">${chkPags}</div>
      </div>
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">🏷️ Tipos de produto permitidos</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">${chkTipos}</div>
      </div>
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">⚙️ Funcionalidades</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">${chkFuncs}</div>
      </div>
      <button class="btn btn-primary" onclick="salvarFeatures()"><i class="fas fa-save"></i> Salvar Features</button>
    </div>`;
  targets.forEach((el) => {
    el.innerHTML = html;
  });
}

function iniciarRealtime() {
  supa
    .channel("tabela-pedidos-admin")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pedidos" },
      (payload) => {
        // Som só para pedido NOVO pendente (nunca para cancelamento ou update)
        if (
          payload.eventType === "INSERT" &&
          payload.new.status === "pendente"
        ) {
          tocarAlarme();
        }
        // Atualiza tela — silencioso=true em updates para não re-tocar alarme
        const silencioso = payload.eventType === "UPDATE";
        const abaAtual = localStorage.getItem("app_lastTab");
        if (abaAtual === "pedidos") carregarPedidos(silencioso);
        if (abaAtual === "cozinha") carregarCozinha();
        if (abaAtual === "dashboard") carregarDashboard();
      },
    )
    .subscribe();
}

// ── Variáveis de estado ──────────────────────────────────────
let loopAlarme = null;
let _alarmePlaying = false;

function tocarAlarme() {
  const audio = document.getElementById("som-campainha");
  if (!audio || loopAlarme) return; // já está tocando

  const _tocar = () => {
    if (!_alarmePlaying) {
      _alarmePlaying = true;
      audio.currentTime = 0;
      audio
        .play()
        .then(() => {
          _alarmePlaying = false;
        })
        .catch(() => {
          _alarmePlaying = false;
        });
    }
  };

  _tocar();
  loopAlarme = setInterval(_tocar, 4000);
}

function pararAlarme() {
  if (loopAlarme) {
    clearInterval(loopAlarme);
    loopAlarme = null;
  }
  const audio = document.getElementById("som-campainha");
  if (audio && !audio.paused) {
    audio.pause();
    audio.currentTime = 0;
  }
  _alarmePlaying = false;
}

// =========================================
// 4. GESTÃO DE PEDIDOS (COM IMPRESSÃO)
// =========================================
async function carregarPedidos(silencioso = false) {
  // === TRAVA DE SEGURANÇA (Para não limpar sua seleção) ===
  if (silencioso) {
    const selecionados = document.querySelectorAll(".check-pedido:checked");
    if (selecionados.length > 0) {
      console.log("Atualização pausada: Usuário está montando rota.");
      return;
    }
  }

  // 1. Som e Notificação
  const { count, error: countError } = await supa
    .from("pedidos")
    .select("*", { count: "exact", head: true })
    .eq("status", "pendente");

  if (countError) {
    console.warn("Erro ao contar pedidos pendentes:", countError.message);
  }

  if (count > 0) {
    if (!silencioso && typeof tocarAlarme === "function") tocarAlarme();
  } else {
    if (typeof pararAlarme === "function") pararAlarme();
  }

  // 2. Busca Dados - inclui cancelamento_solicitado para badge
  const { data: pedidos } = await supa
    .from("pedidos")
    .select("*")
    .or(
      "status.eq.pendente,status.eq.em_preparo,status.eq.pronto_entrega,status.eq.saiu_entrega",
    )
    .order("id", { ascending: false });

  const tbody = document.getElementById("lista-pedidos");
  if (!tbody) return;
  tbody.innerHTML = "";

  // Container de cards mobile
  const cardsDiv = document.getElementById("lista-pedidos-cards");
  if (cardsDiv) cardsDiv.innerHTML = "";

  // ── AUTO-CONFIRM: pedidos saiu_entrega há mais de 4h ──────────────────────
  const _QUATRO_HORAS_MS = 4 * 60 * 60 * 1000;
  const _agora = Date.now();
  const pedidosParaAutoConfirmar = (pedidos || []).filter(
    (p) =>
      p.status === "saiu_entrega" &&
      p.tempo_saiu_entrega &&
      _agora - new Date(p.tempo_saiu_entrega).getTime() > _QUATRO_HORAS_MS,
  );
  for (const p of pedidosParaAutoConfirmar) {
    console.log(
      `⏰ Auto-confirmando entrega do pedido #${p.id} (mais de 4h em saiu_entrega)`,
    );
    await supa
      .from("pedidos")
      .update({
        status: "entregue",
        tempo_entregue: new Date().toISOString(),
      })
      .eq("id", p.id);
  }
  // ───────────────────────────────────────────────────────────────────────────

  // Badge de cancelamento pendente para o dono / adminMaster
  const _podeCancel = ["dono", "adminMaster", "gerente"].includes(
    perfilUsuario,
  );
  const badgeCancelPendente = _podeCancel
    ? `<span style="background:#e74c3c;color:white;font-size:0.7rem;padding:2px 7px;border-radius:10px;margin-left:6px;vertical-align:middle;">CANC. PENDENTE</span>`
    : "";

  if (pedidos && pedidos.length > 0) {
    pedidos.forEach((p) => {
      let acoes = "";
      let linhaCor = "";
      let checkbox = "";

      const btnPrint = `<button class="btn btn-sm btn-info" onclick="imprimirPedido(${p.id})" title="Imprimir"><i class="fas fa-print"></i></button>`;
      const temSolicitacaoCancelamento = p.cancelamento_solicitado;

      // Badge cancelamento (dono + gerente veem)
      const badgeCancelRow =
        temSolicitacaoCancelamento &&
        ["dono", "gerente", "adminMaster"].includes(perfilUsuario)
          ? `<div style="background:#fff0f0;border:1px solid #e74c3c;border-radius:6px;padding:4px 8px;font-size:0.75rem;margin-top:4px;color:#c0392b">
                     🚫 <strong>Cancelamento solicitado:</strong> ${p.cancelamento_motivo || "-"}
                     <br><button class="btn btn-danger btn-sm" onclick="aprovarCancelamento(${p.id})" style="margin-top:4px;font-size:0.7rem">✅ Aprovar</button>
                     <button class="btn btn-secondary btn-sm" onclick="negarCancelamento(${p.id})" style="margin-top:4px;font-size:0.7rem">❌ Negar</button>
                   </div>`
          : "";

      // PENDENTE
      if (p.status === "pendente") {
        linhaCor = "background-color: #fff3cd;";
        acoes = `
                    ${btnPrint}
                    <button class="btn btn-success btn-sm" onclick="mudarStatus(${p.id}, 'em_preparo')"><i class="fas fa-fire"></i> Separação</button>
                    ${
                      _podeCancel
                        ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
                        : `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Solicitar Cancelamento</button>`
                    }
                `;
      }

      // EM PREPARO (na cozinha — visível para acompanhamento)
      if (p.status === "em_preparo") {
        linhaCor = "background-color: #fff8e6;";
        const _btnCancelPreparo = _podeCancel
          ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')" title="Cancelar"><i class="fas fa-times"></i></button>`
          : !temSolicitacaoCancelamento
            ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i></button>`
            : `<span style="font-size:0.72rem;color:#e67e22;font-weight:600">⏳ Cancel. Pendente</span>`;
        acoes = `${btnPrint} <button class="btn btn-sm" style="background:#e67e22;color:#fff" onclick="mudarStatus(${p.id}, 'pronto_entrega')"><i class="fas fa-check"></i> Pronto</button> ${_btnCancelPreparo}`;
      }

      if (p.status === "saiu_entrega") {
        linhaCor = "background-color: #ddf0ff;";
        const _btnCancelSaiu = _podeCancel
          ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')" title="Cancelar"><i class="fas fa-times"></i></button>`
          : !temSolicitacaoCancelamento
            ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})" title="Solicitar cancelamento"><i class="fas fa-ban"></i> Cancelar</button>`
            : `<span style="font-size:0.72rem;color:#e67e22;font-weight:600">⏳ Cancel. Pendente</span>`;
        acoes = `${btnPrint} <button class="btn btn-success btn-sm" onclick="confirmarEntregaFuncionario(${p.id})"><i class="fas fa-check-circle"></i> Confirmar</button> ${_btnCancelSaiu}`;
      }
      // PRONTO
      else if (p.status === "pronto_entrega") {
        linhaCor = "background-color: #d4edda;";

        // Botão cancelamento para pronto_entrega
        const btnCancelar = _podeCancel
          ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')" title="Cancelar"><i class="fas fa-times"></i></button>`
          : !temSolicitacaoCancelamento
            ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i></button>`
            : "";

        if (p.tipo_entrega === "delivery") {
          const jsonSeguro = encodeURIComponent(JSON.stringify(p));
          checkbox = `<input type="checkbox" class="check-pedido" value="${jsonSeguro}" style="width:20px; height:20px;">`;
          acoes = `${btnPrint} ${btnCancelar} <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})" title="Avisar cliente via WhatsApp"><i class="fab fa-whatsapp"></i></button> <span style="color:#155724; font-weight:bold; font-size:0.9rem; margin-left:5px;"><i class="fas fa-motorcycle"></i> Aguardando Rota</span>`;
        } else {
          const icone =
            p.tipo_entrega === "balcao" ? "fa-store" : "fa-hand-holding";
          const tipo = p.tipo_entrega === "balcao" ? "BALCÃO" : "RETIRADA";
          checkbox = `<div style="text-align:center; color:#e67e22; font-size:1.2rem"><i class="fas ${icone}" title="${tipo}"></i></div>`;
          acoes = `${btnPrint} ${btnCancelar} <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})" title="Avisar cliente via WhatsApp"><i class="fab fa-whatsapp"></i></button> <button class="btn btn-success btn-sm" onclick="finalizarMesa(${p.id})">Baixar</button>`;
        }
      }

      // Linha da tabela (desktop)
      tbody.innerHTML += `
                <tr style="${linhaCor}">
                    <td style="text-align:center; vertical-align: middle;">${checkbox}</td>
                    <td><strong>#${p.uid_temporal || p.id}</strong></td>
                    <td>
                        <div style="font-weight:bold">${p.cliente_nome || "Cliente"}</div>
                        <div style="font-size:0.8rem; color:#666">${p.endereco_entrega || ""}</div>
                        ${badgeCancelRow}
                    </td>
                    <td><span class="status-badge st-${p.status}">${p.status.toUpperCase().replace("_", " ")}</span>
                    ${temSolicitacaoCancelamento && _podeCancel ? badgeCancelPendente : ""}</td>
                    <td>Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</td>
                    <td class="actions-cell">${acoes}</td>
                </tr>`;

      // Card mobile
      if (cardsDiv) {
        const statusLabel =
          p.status === "pendente"
            ? "🔔 Novo"
            : p.status === "em_preparo"
              ? "🔥 Em Separação"
              : p.status === "pronto_entrega"
                ? "✅ Pronto"
                : p.status.replace("_", " ");
        const cardBg =
          p.status === "pendente"
            ? "#fff3cd"
            : p.status === "pronto_entrega"
              ? "#d4edda"
              : p.status === "saiu_entrega"
                ? "#ddf0ff"
                : "#fff";
        const jsonSeguro = encodeURIComponent(JSON.stringify(p));
        let cardAcoes = "";
        const cardBgSaiu = p.status === "saiu_entrega" ? "#ddf0ff" : "";
        if (p.status === "saiu_entrega") {
          const _btnCancelSaiuCard = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
              : `<span style="font-size:0.7rem;color:#e67e22;font-weight:600">⏳ Pendente</span>`;
          cardAcoes = `
                        <button class="btn btn-success btn-sm" onclick="confirmarEntregaFuncionario(${p.id})"><i class="fas fa-check-circle"></i> Confirmar</button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i> Imprimir</button>
                        ${_btnCancelSaiuCard}`;
        } else if (p.status === "pendente") {
          cardAcoes = `
                        <button class="btn btn-success btn-sm" onclick="mudarStatus(${p.id}, 'em_preparo')"><i class="fas fa-fire"></i> Seáração</button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i> Imprimir</button>
                        ${
                          _podeCancel
                            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
                            : `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
                        }`;
        } else if (p.status === "em_preparo") {
          const _btnCancelPreparoCard = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
              : `<span style="font-size:0.7rem;color:#e67e22;font-weight:600">⏳ Pendente</span>`;
          cardAcoes = `
                        <button class="btn btn-sm" style="background:#e67e22;color:#fff" onclick="mudarStatus(${p.id}, 'pronto_entrega')"><i class="fas fa-check"></i> Pronto</button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i> Imprimir</button>
                        ${_btnCancelPreparoCard}`;
        } else if (
          p.status === "pronto_entrega" &&
          p.tipo_entrega === "balcao"
        ) {
          const _btnCancelBalcao = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
              : "";
          cardAcoes = `<button class="btn btn-success btn-sm" onclick="finalizarMesa(${p.id})"><i class="fas fa-check"></i> Entregar</button>
                        <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})"><i class="fab fa-whatsapp"></i></button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i></button>
                        ${_btnCancelBalcao}`;
        } else if (p.status === "pronto_entrega") {
          const _btnCancelPronto = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i></button>`
              : "";
          cardAcoes = `<label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:#155724;font-weight:600;">
                        <input type="checkbox" class="check-pedido" value="${jsonSeguro}" style="width:18px;height:18px;"> Incluir na Rota
                    </label>
                    <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})"><i class="fab fa-whatsapp"></i> Avisar</button>
                    <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i></button>
                    ${_btnCancelPronto}`;
        }

        const badgeCancelCard =
          temSolicitacaoCancelamento && _podeCancel
            ? `
                    <div style="background:#fff0f0;border:1px solid #e74c3c;border-radius:6px;padding:6px 8px;font-size:0.75rem;color:#c0392b;margin-top:6px">
                        🚫 Cancel. solicitado: ${p.cancelamento_motivo || "-"}
                        <br><button class="btn btn-danger btn-sm" onclick="aprovarCancelamento(${p.id})" style="font-size:0.7rem;margin-top:4px">✅ Aprovar</button>
                        <button class="btn btn-secondary btn-sm" onclick="negarCancelamento(${p.id})" style="font-size:0.7rem;margin-top:4px">❌ Negar</button>
                    </div>`
            : "";

        // ── Lista de itens do pedido para o card mobile ──────────────────
        const _itensCardHtml = (p.itens || []).map((item) => {
          const _q  = item.qtd || item.q || 1;
          const _n  = item.nome || item.n || "?";
          const _v  = item.variacao || item.t || "";
          return `<div style="font-size:0.75rem;color:#444;line-height:1.4">
            <span style="font-weight:700;color:#1a7a2e">${_q}×</span> ${_n}${_v && _v !== _n ? ` <span style="color:#e67e22">▸ ${_v}</span>` : ""}
          </div>`;
        }).join("");

        cardsDiv.innerHTML += `
                    <div style="background:${cardBg}; border-radius:10px; padding:14px 16px; box-shadow:0 2px 8px rgba(0,0,0,0.07); border-left:4px solid ${p.status === "pendente" ? "#f59e0b" : p.status === "pronto_entrega" ? "#22c55e" : p.status === "saiu_entrega" ? "#3498db" : "#94a3b8"};">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                            <div>
                                <div style="font-weight:700;font-size:1rem">Pedido #${p.id} — ${p.cliente_nome || "Cliente"}</div>
                                <div style="font-size:0.78rem;color:#666;margin-top:2px">${p.endereco_entrega || (p.tipo_entrega === "balcao" ? "🏪 Balcão" : "")}</div>
                            </div>
                            <span class="status-badge st-${p.status}" style="font-size:0.7rem">${statusLabel}</span>
                        </div>
                        ${_itensCardHtml ? `<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:7px;padding:7px 10px;margin-bottom:8px">${_itensCardHtml}</div>` : ""}
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                              <strong style="font-size:1rem;color:var(--dark)">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</strong>
                              ${p.frete_motoboy ? `<div style="font-size:0.72rem;color:#27ae60;margin-top:2px">🛵 Motoboy: Gs ${p.frete_motoboy.toLocaleString("es-PY")}</div>` : ""}
                            </div>
                            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${cardAcoes}</div>
                        </div>
                        ${badgeCancelCard}
                    </div>`;
      }
    });
  } else {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center; padding:20px; color:#999;">Nenhum pedido ativo.</td></tr>';
    if (cardsDiv)
      cardsDiv.innerHTML =
        '<div style="text-align:center;padding:30px;color:#aaa;font-size:0.95rem">Nenhum pedido ativo no momento.</div>';
  }
}

// === CANCELAMENTO WORKFLOW ===
async function solicitarCancelamento(pedidoId) {
  const motivo = prompt(t("prompt.motivo_cancel"));
  if (!motivo || !motivo.trim()) return;

  const user = await supa.auth.getUser();
  const email = user?.data?.user?.email || "desconhecido";

  const { error } = await supa
    .from("pedidos")
    .update({
      cancelamento_solicitado: true,
      cancelamento_motivo: motivo.trim(),
      cancelamento_solicitado_por: email,
      cancelamento_solicitado_em: new Date().toISOString(),
    })
    .eq("id", pedidoId);

  if (error) {
    alert("❌ Erro: " + error.message);
    return;
  }

  // Registra na tabela de solicitações (falha silenciosa não bloqueia o fluxo)
  const { error: errSol } = await supa
    .from("solicitacoes_cancelamento")
    .insert([
      {
        pedido_id: pedidoId,
        motivo: motivo.trim(),
        solicitado_por: email,
      },
    ]);
  if (errSol) console.warn("solicitacoes_cancelamento insert:", errSol.message);

  alert(t("alert.cancel_enviado"));
  carregarPedidos();
}

async function aprovarCancelamento(pedidoId) {
  if (
    !confirm(
      "⚠️ Confirma o CANCELAMENTO deste pedido?\nEsta ação não pode ser desfeita.",
    )
  )
    return;

  const user = await supa.auth.getUser();
  const email = user?.data?.user?.email || "dono" || "gerente";

  // Verifica ANTES do update se o estoque deste pedido já tinha sido
  // descontado. Pedidos ainda "pendente" (nunca passaram por em_preparo,
  // PDV balcão, ou mesa) nunca tiveram estoque baixado — repor nesse caso
  // criaria estoque fantasma (a mais).
  const { data: _pedAntesCancelamento } = await supa
    .from("pedidos")
    .select("estoque_descontado")
    .eq("id", pedidoId)
    .single();

  const { error } = await supa
    .from("pedidos")
    .update({
      status: "cancelado",
      cancelamento_aprovado_por: email,
      cancelamento_aprovado_em: new Date().toISOString(),
    })
    .eq("id", pedidoId);

  if (error) {
    alert("❌ Erro: " + error.message);
    return;
  }

  // Bug #7 corrigido: repõe estoque ao aprovar cancelamento —
  // SOMENTE se o estoque deste pedido tinha sido efetivamente descontado.
  if (_pedAntesCancelamento?.estoque_descontado) {
    await _reporEstoqueCancelamento(pedidoId);
    // Zera a flag: este pedido voltou a "não ter estoque comprometido"
    await supa
      .from("pedidos")
      .update({ estoque_descontado: false })
      .eq("id", pedidoId);
  }
  // Bug #6 corrigido: estorna cashback ao aprovar cancelamento
  await _estornarCashbackCancelamento(pedidoId);

  // Marca como aprovada na tabela de solicitações
  await supa
    .from("solicitacoes_cancelamento")
    .update({
      aprovado: true,
      aprovado_por: email,
      aprovado_em: new Date().toISOString(),
    })
    .eq("pedido_id", pedidoId)
    .eq("aprovado", false);

  alert(t("alert.cancelado"));
  carregarPedidos();
}

async function negarCancelamento(pedidoId) {
  const obs = prompt(t("prompt.negar_cancel")) || "";
  const user = await supa.auth.getUser();
  const email = user?.data?.user?.email || "dono" || "gerente";

  await supa
    .from("pedidos")
    .update({
      cancelamento_solicitado: false,
      cancelamento_motivo: null,
    })
    .eq("id", pedidoId);

  await supa
    .from("solicitacoes_cancelamento")
    .update({
      negado: true,
      negado_por: email,
      negado_em: new Date().toISOString(),
      observacoes: obs,
    })
    .eq("pedido_id", pedidoId)
    .eq("aprovado", false);

  alert(t("alert.cancel_negado"));
  carregarPedidos();
}

async function mudarStatus(id, novoStatus) {
  // Registra o timestamp do novo status no campo correspondente
  const camposTimestamp = {
    em_preparo: ["tempo_confirmado", "tempo_preparo_iniciado"], // aceita E começa a preparar
    pronto_entrega: "tempo_pronto",
    saiu_entrega: "tempo_saiu_entrega",
    entregue: "tempo_entregue",
  };

  // Se for cancelamento, verifica ANTES se o estoque deste pedido já foi
  // descontado — necessário para decidir se deve repor depois do update.
  let _estoqueJaDescontadoAntes = false;
  if (novoStatus === "cancelado") {
    const { data: _pedAntesCancel } = await supa
      .from("pedidos")
      .select("estoque_descontado")
      .eq("id", id)
      .single();
    _estoqueJaDescontadoAntes = !!_pedAntesCancel?.estoque_descontado;
  }

  const updateData = { status: novoStatus };
  const campos = camposTimestamp[novoStatus];
  if (campos) {
    const agora = new Date().toISOString();
    if (Array.isArray(campos)) campos.forEach((c) => (updateData[c] = agora));
    else updateData[campos] = agora;
  }
  // Status 'cancelado' mantém os timestamps existentes

  const { error } = await supa.from("pedidos").update(updateData).eq("id", id);
  if (error) {
    console.error("Erro ao atualizar:", error);
    alert("Erro ao mudar status");
    return;
  }

  if (novoStatus === "em_preparo") {
    await _descontarEstoqueVenda(id, null);
    // Marca como descontado para evitar duplo desconto em finalizarMesa
    await supa.from("pedidos").update({ estoque_descontado: true }).eq("id", id);
  }

  // Bug #7 corrigido: repõe estoque ao cancelar — SOMENTE se já tinha
  // sido descontado antes (pedidos "pendente" cancelados direto nunca
  // descontaram, então não devem repor nada).
  if (novoStatus === "cancelado" && _estoqueJaDescontadoAntes) {
    await _reporEstoqueCancelamento(id);
    await supa.from("pedidos").update({ estoque_descontado: false }).eq("id", id);
  }

  // Bug #6 corrigido: estorna cashback gerado ao cancelar
  if (novoStatus === "cancelado") await _estornarCashbackCancelamento(id);

  if (typeof pararAlarme === "function") pararAlarme();

  // Notifica o cliente via Web Push (ignora silenciosamente se falhar)
  _notificarClientePush(id, novoStatus);

  const abaAtual = localStorage.getItem("app_lastTab");
  if (abaAtual === "cozinha") carregarCozinha();
  else if (abaAtual === "pedidos") carregarPedidos();
  else if (abaAtual === "pdv") carregarMonitorMesas();
}

// Dispara a Edge Function notificar-cliente de forma fire-and-forget
async function _notificarClientePush(pedidoId, status) {
  try {
    const supaUrl =
      window._SUPABASE_URL ||
      (typeof _SUPABASE_URL !== "undefined" ? _SUPABASE_URL : "");
    if (!supaUrl) return;
    const fnUrl =
      supaUrl.replace("/rest/v1", "").replace(/\/+$/, "") +
      "/functions/v1/notificar-cliente";
    // Usa a chave anon — a Edge Function usa service role internamente
    const { data: session } = await supa.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) return;
    fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pedido_id: pedidoId, status }),
    }).catch(() => {}); // fire-and-forget, nunca bloqueia
  } catch (_) {
    /* silencioso */
  }
}

// === FUNÇÃO DE IMPRESSÃO (RESTAURADA) ===
async function imprimirPedido(id) {
  const { data: p } = await supa
    .from("pedidos")
    .select("*")
    .eq("id", id)
    .single();
  if (!p) return;

  const dados = {
    id: p.id,
    cliente: { nome: p.cliente_nome, tel: p.cliente_telefone },
    entrega: { tipo: p.tipo_entrega, ref: p.endereco_entrega },
    // Imprime apenas itens pendentes (sem status ou status 'pendente')
    itens: (p.itens || [])
      .filter((i) => !i.status_item || i.status_item === "pendente")
      .map((i) => ({
        q: i.qtd || i.q || 1,
        n: i.nome || i.n,
        p: i.preco || i.p || 0,
        t: i.variacao || i.t || "",
        pr: i.preparo || i.pr || "",
        m: i.montagem || i.m,
        o: i.obs || i.o,
        // Kg — necessário para imprimir.html mostrar peso em vez de qtd
        _isKg: i._isKg || false,
        peso_gramas: i.peso_gramas || 0,
      })),
    valores: {
      sub: p.subtotal,
      frete: p.frete_cobrado_cliente,
      total: p.total_geral,
    },
    pagamento: { metodo: p.forma_pagamento, obs: p.obs_pagamento },
    factura: p.dados_factura,
    data: new Date(p.created_at || Date.now()).toLocaleString("pt-BR"),
  };

  const jsonStr = JSON.stringify(dados);
  // Base64 URL-safe: substitui +, / e = que quebram a URL
  const base64 = btoa(unescape(encodeURIComponent(jsonStr)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Abre a janela de impressão
  window.open(`imprimir.html?d=${base64}`, "Print", "width=420,height=700");
}

// =========================================
// 5. TELA COZINHA
// =========================================
// ══════════════════════════════════════════════════════════════
//  LISTA DE SEPARAÇÃO — substitui o KDS de cozinha
//  Exibe pedidos com checkboxes por item, impressão e resumo
//  consolidado de todos os produtos a separar.
// ══════════════════════════════════════════════════════════════

let _sepPedidos = []; // pedidos carregados do banco
let _sepChecks = {}; // { "pedidoId-itemIdx": true/false } — estado dos checks

// ── carregarCozinha — mantém o nome para compatibilidade com showTab ──
async function carregarCozinha() {
  await sepRecarregar();
}

async function sepRecarregar() {
  const sel = document.getElementById("sep-filtro-status");
  const status = (sel?.value || "em_preparo,pronto_entrega").split(",");

  const cont = document.getElementById("sep-lista-pedidos");
  if (cont)
    cont.innerHTML = `
    <div style="text-align:center;padding:40px;color:#aaa">
      <i class="fas fa-spinner fa-spin" style="font-size:2rem"></i>
      <p style="margin-top:12px">Carregando pedidos…</p>
    </div>`;

  const { data, error } = await supa
    .from("pedidos")
    .select(
      "id, uid_temporal, cliente_nome, cliente_telefone, endereco_entrega, itens, status, created_at, forma_pagamento, obs_pagamento, total_geral",
    )
    .in("status", status)
    .order("id", { ascending: true });

  if (error) {
    if (cont)
      cont.innerHTML = `<p style="color:#e74c3c;padding:20px">Erro: ${error.message}</p>`;
    return;
  }

  _sepPedidos = data || [];
  _sepRenderizar();
}

function _sepRenderizar() {
  const cont = document.getElementById("sep-lista-pedidos");
  const agrupar = document.getElementById("sep-agrupar")?.checked !== false;
  if (!cont) return;

  if (!_sepPedidos.length) {
    cont.innerHTML = `
      <div style="text-align:center;padding:50px;color:#aaa">
        <div style="font-size:3rem;margin-bottom:12px">✅</div>
        <div style="font-size:1.1rem;font-weight:600">Nenhum pedido pendente de separação!</div>
      </div>`;
    _sepRenderizarResumo([]);
    return;
  }

  if (agrupar) {
    cont.innerHTML = _sepPedidos.map((p) => _sepHtmlPedido(p)).join("");
  } else {
    // Visão consolidada — todos os itens de todos os pedidos numa lista só
    cont.innerHTML = _sepHtmlConsolidado(_sepPedidos);
  }

  _sepRenderizarResumo(_sepPedidos);
}

// ──────────────────────────────────────────────────────────────
//  HTML de um card de pedido com checkboxes
// ──────────────────────────────────────────────────────────────
function _sepHtmlPedido(p) {
  const num = p.uid_temporal || p.id;
  const cliente = p.cliente_nome || "Cliente";
  const hora = new Date(p.created_at).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const itens = Array.isArray(p.itens) ? p.itens : [];
  const statusCor =
    {
      em_preparo: "#f59e0b",
      pronto_entrega: "#22c55e",
      saiu_entrega: "#3b82f6",
    }[p.status] || "#94a3b8";

  const statusLabel =
    {
      em_preparo: "Em separação",
      pronto_entrega: "Pronto p/ envio",
      saiu_entrega: "Saiu p/ entrega",
    }[p.status] || p.status;

  // Verifica se todos os itens estão marcados
  const todosChecked = itens.every((_, i) => _sepChecks[`${p.id}-${i}`]);

  const itensHtml = itens
    .map((item, idx) => {
      const checkId = `sep-chk-${p.id}-${idx}`;
      const checked = _sepChecks[`${p.id}-${idx}`] ? "checked" : "";
      const qtd = item.qtd || item.q || 1;
      const nome = item.nome || item.n || "Item";
      const variacao = item.variacao || item.t || "";
      const obs = item.obs || item.o || "";
      const unidade = item.unidade_venda || "";

      const varTag = variacao
        ? `<span class="sep-variacao">▸ ${variacao}</span>`
        : "";
      const unidTag = unidade
        ? `<span class="sep-unidade">${unidade}</span>`
        : "";
      const obsTag = obs ? `<div class="sep-obs">⚠️ ${obs}</div>` : "";

      return `
      <label class="sep-item-row ${checked ? "sep-item-checked" : ""}"
        for="${checkId}" onclick="sepToggleItem('${p.id}', ${idx}, this)">
        <input type="checkbox" id="${checkId}" class="sep-checkbox" ${checked}
          onclick="event.stopPropagation(); sepToggleItem('${p.id}', ${idx}, this.closest('label'))">
        <div class="sep-item-body">
          <div class="sep-item-nome">
            <strong>${qtd}×</strong> ${nome} ${varTag} ${unidTag}
          </div>
          ${obsTag}
        </div>
      </label>`;
    })
    .join("");

  return `
    <div class="sep-card" id="sep-card-${p.id}" data-pedido-id="${p.id}">

      <!-- Cabeçalho do card -->
      <div class="sep-card-header" style="border-left-color:${statusCor}">
        <div class="sep-card-info">
          <span class="sep-num">#${num}</span>
          <span class="sep-cliente">${cliente}</span>
          <span class="sep-hora">🕐 ${hora}</span>
        </div>
        <div class="sep-card-badges">
          <span class="sep-status-badge" style="background:${statusCor}20;color:${statusCor};border:1px solid ${statusCor}40">
            ${statusLabel}
          </span>
          ${
            p.forma_pagamento
              ? `<span class="sep-pgto-badge">${_sepIconePgto(p.forma_pagamento)} ${p.forma_pagamento}</span>`
              : ""
          }
        </div>
      </div>

      <!-- Endereço se houver -->
      ${
        p.endereco_entrega
          ? `
        <div class="sep-endereco">
          <i class="fas fa-location-dot"></i> ${p.endereco_entrega}
        </div>`
          : ""
      }

      <!-- Lista de itens com checkboxes -->
      <div class="sep-itens-lista">
        ${itensHtml}
      </div>

      <!-- Rodapé: ações -->
      <div class="sep-card-footer">
        <div class="sep-total">
          Total: <strong>Gs ${Math.round(p.total_geral || 0).toLocaleString("es-PY")}</strong>
        </div>
        <div class="sep-acoes">
          <button class="btn btn-sm sep-btn-print" onclick="sepImprimirPedido(${p.id})"
            title="Imprimir este pedido">
            <i class="fas fa-print"></i>
          </button>
          <button class="btn btn-sm sep-btn-limpar" onclick="sepLimparChecks(${p.id})"
            title="Desmarcar tudo">
            <i class="fas fa-rotate-left"></i>
          </button>
          ${
            p.status === "em_preparo"
              ? `
          <button class="btn btn-sm sep-btn-pronto"
            onclick="mudarStatus(${p.id}, 'pronto_entrega').then(()=>sepRecarregar())"
            title="Marcar como pronto para envio">
            <i class="fas fa-check"></i> Pronto p/ envio
          </button>`
              : ""
          }
          ${
            p.status === "pronto_entrega"
              ? `
          <button class="btn btn-sm sep-btn-saiu"
            onclick="mudarStatus(${p.id}, 'saiu_entrega').then(()=>sepRecarregar())"
            title="Saiu para entrega">
            <i class="fas fa-motorcycle"></i> Saiu p/ entrega
          </button>`
              : ""
          }
        </div>
      </div>

    </div>`;
}

// ──────────────────────────────────────────────────────────────
//  HTML consolidado (sem agrupamento — lista única)
// ──────────────────────────────────────────────────────────────
function _sepHtmlConsolidado(pedidos) {
  // Agrega todos os itens de todos os pedidos
  const mapa = {}; // "nome|variacao" → { nome, variacao, qtd, pedidos[] }

  pedidos.forEach((p) => {
    (p.itens || []).forEach((item) => {
      const nome = item.nome || item.n || "Item";
      const variacao = item.variacao || item.t || "";
      const qtd = item.qtd || item.q || 1;
      const chave = `${nome}|||${variacao}`;
      if (!mapa[chave]) mapa[chave] = { nome, variacao, qtd: 0, pedidos: [] };
      mapa[chave].qtd += qtd;
      mapa[chave].pedidos.push(`#${p.uid_temporal || p.id}`);
    });
  });

  const linhas = Object.values(mapa)
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map((it, idx) => {
      const checkId = `sep-cons-${idx}`;
      const varTag = it.variacao
        ? `<span class="sep-variacao">▸ ${it.variacao}</span>`
        : "";
      return `
        <label class="sep-item-row" for="${checkId}"
          onclick="this.classList.toggle('sep-item-checked')">
          <input type="checkbox" id="${checkId}" class="sep-checkbox"
            onclick="event.stopPropagation();this.closest('label').classList.toggle('sep-item-checked')">
          <div class="sep-item-body">
            <div class="sep-item-nome">
              <strong>${it.qtd}×</strong> ${it.nome} ${varTag}
            </div>
            <div style="font-size:0.72rem;color:#888;margin-top:2px">
              Pedidos: ${it.pedidos.join(", ")}
            </div>
          </div>
        </label>`;
    })
    .join("");

  return `
    <div class="sep-card">
      <div class="sep-card-header" style="border-left-color:#8b5cf6">
        <div class="sep-card-info">
          <span class="sep-num">Lista Consolidada</span>
          <span class="sep-cliente">${pedidos.length} pedidos — ${Object.keys(mapa).length} itens distintos</span>
        </div>
        <button class="btn btn-sm sep-btn-print" onclick="sepImprimirTudo()" style="margin-left:auto">
          <i class="fas fa-print"></i> Imprimir
        </button>
      </div>
      <div class="sep-itens-lista">${linhas}</div>
    </div>`;
}

// ──────────────────────────────────────────────────────────────
//  Resumo consolidado no topo da aba
// ──────────────────────────────────────────────────────────────
function _sepRenderizarResumo(pedidos) {
  const wrap = document.getElementById("sep-resumo-global");
  const listEl = document.getElementById("sep-resumo-lista");
  if (!wrap || !listEl) return;

  if (!pedidos.length) {
    wrap.style.display = "none";
    return;
  }

  // Contabiliza itens
  const mapa = {};
  pedidos.forEach((p) => {
    (p.itens || []).forEach((item) => {
      const nome = item.nome || item.n || "Item";
      const v = item.variacao || item.t || "";
      const k = `${nome}|||${v}`;
      if (!mapa[k]) mapa[k] = { nome, variacao: v, qtd: 0 };
      mapa[k].qtd += item.qtd || item.q || 1;
    });
  });

  const sorted = Object.values(mapa).sort((a, b) =>
    a.nome.localeCompare(b.nome),
  );

  listEl.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${sorted
        .map(
          (it) => `
        <span style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;
          padding:4px 10px;font-size:0.8rem;font-weight:600;color:#374151">
          <strong style="color:#1a7a2e">${it.qtd}×</strong>
          ${it.nome}${it.variacao ? ` <span style="color:#888;font-weight:400">▸ ${it.variacao}</span>` : ""}
        </span>`,
        )
        .join("")}
    </div>`;

  wrap.style.display = "block";
}

// ──────────────────────────────────────────────────────────────
//  Interação: check/uncheck de item
// ──────────────────────────────────────────────────────────────
function sepToggleItem(pedidoId, idx, labelEl) {
  const key = `${pedidoId}-${idx}`;
  _sepChecks[key] = !_sepChecks[key];
  labelEl.classList.toggle("sep-item-checked", !!_sepChecks[key]);
  const chk = labelEl.querySelector("input[type=checkbox]");
  if (chk) chk.checked = !!_sepChecks[key];

  // Atualiza progresso do card
  _sepAtualizarProgresso(pedidoId);
}

function sepLimparChecks(pedidoId) {
  const p = _sepPedidos.find((x) => x.id === pedidoId);
  if (!p) return;
  (p.itens || []).forEach((_, i) => {
    _sepChecks[`${pedidoId}-${i}`] = false;
  });
  // Re-renderiza só o card afetado
  const card = document.getElementById(`sep-card-${pedidoId}`);
  if (card) card.outerHTML = _sepHtmlPedido(p);
}

function _sepAtualizarProgresso(pedidoId) {
  const p = _sepPedidos.find((x) => x.id === pedidoId);
  if (!p) return;
  const total = (p.itens || []).length;
  const marcados = (p.itens || []).filter(
    (_, i) => _sepChecks[`${pedidoId}-${i}`],
  ).length;
  // Visual feedback: card fica esverdeado quando tudo marcado
  const card = document.getElementById(`sep-card-${pedidoId}`);
  if (!card) return;
  if (marcados === total && total > 0) {
    card.style.borderColor = "#22c55e";
    card.style.background = "#f0fdf4";
  } else {
    card.style.borderColor = "";
    card.style.background = "";
  }
}

// ──────────────────────────────────────────────────────────────
//  Busca inline (filtra cards sem ir ao banco)
// ──────────────────────────────────────────────────────────────
function sepFiltrarBusca(termo) {
  const t = termo.toLowerCase().trim();
  document.querySelectorAll(".sep-card[data-pedido-id]").forEach((card) => {
    const pid = card.dataset.pedidoId;
    const p = _sepPedidos.find((x) => String(x.id) === pid);
    if (!p) return;
    const texto = [
      p.uid_temporal,
      p.id,
      p.cliente_nome,
      p.cliente_telefone,
      ...(p.itens || []).map((i) => i.nome || i.n || ""),
    ]
      .join(" ")
      .toLowerCase();
    card.style.display = !t || texto.includes(t) ? "" : "none";
  });
}

// ──────────────────────────────────────────────────────────────
//  Impressão
// ──────────────────────────────────────────────────────────────
function _sepGerarHtmlImpressao(pedidos) {
  const data = new Date().toLocaleString("pt-BR");

  const blocos = pedidos
    .map((p) => {
      const num = p.uid_temporal || p.id;
      const itens = (p.itens || [])
        .map((item, idx) => {
          const qtd = item.qtd || item.q || 1;
          const nome = item.nome || item.n || "Item";
          const var_ = item.variacao || item.t || "";
          const obs = item.obs || item.o || "";
          const unid = item.unidade_venda || "";
          return `
        <tr>
          <td style="width:28px;text-align:center">
            <span style="display:inline-block;width:16px;height:16px;border:2px solid #333;border-radius:3px"></span>
          </td>
          <td style="padding:5px 8px;font-size:13px">
            <strong>${qtd}×</strong> ${nome}
            ${var_ ? `<em style="color:#555"> ▸ ${var_}</em>` : ""}
            ${unid ? `<span style="background:#e0f2fe;color:#075985;border-radius:3px;padding:0 5px;font-size:11px;margin-left:4px">${unid}</span>` : ""}
            ${obs ? `<div style="color:#dc2626;font-size:11px;margin-top:2px">⚠️ ${obs}</div>` : ""}
          </td>
        </tr>`;
        })
        .join("");

      return `
      <div style="page-break-inside:avoid;border:1.5px solid #ddd;border-radius:8px;
        margin-bottom:16px;overflow:hidden">
        <div style="background:#1a7a2e;color:#fff;padding:8px 14px;display:flex;
          justify-content:space-between;align-items:center">
          <div>
            <strong style="font-size:16px">#${num}</strong>
            <span style="margin-left:10px;font-size:13px">${p.cliente_nome || "Cliente"}</span>
          </div>
          <div style="font-size:12px;opacity:.85">
            ${new Date(p.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        ${
          p.endereco_entrega
            ? `
          <div style="background:#f9fafb;padding:5px 14px;font-size:12px;color:#555;
            border-bottom:1px dashed #e5e7eb">
            📍 ${p.endereco_entrega}
          </div>`
            : ""
        }
        <table style="width:100%;border-collapse:collapse;padding:6px">
          <tbody>${itens}</tbody>
        </table>
        <div style="border-top:1px dashed #e5e7eb;padding:6px 14px;font-size:12px;
          display:flex;justify-content:space-between;color:#555">
          <span>${p.forma_pagamento || ""}</span>
          <strong>Gs ${Math.round(p.total_geral || 0).toLocaleString("es-PY")}</strong>
        </div>
      </div>`;
    })
    .join("");

  return `
    <!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>Lista de Separação</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 16px; color: #111; }
      @media print {
        body { padding: 0; }
        .no-print { display: none; }
      }
    </style>
    </head><body>
    <div class="no-print" style="margin-bottom:16px;display:flex;gap:10px">
      <button onclick="window.print()"
        style="padding:10px 20px;background:#1a7a2e;color:#fff;border:none;
        border-radius:8px;font-size:1rem;cursor:pointer;font-weight:700">
        🖨️ Imprimir
      </button>
      <button onclick="window.close()"
        style="padding:10px 20px;background:#6b7280;color:#fff;border:none;
        border-radius:8px;font-size:1rem;cursor:pointer">
        ✕ Fechar
      </button>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:16px;
      border-bottom:2px solid #1a7a2e;padding-bottom:10px">
      <h2 style="margin:0;color:#1a7a2e">📦 Lista de Separação</h2>
      <div style="font-size:12px;color:#888;text-align:right">
        Impresso em: ${data}<br>
        ${pedidos.length} pedido(s)
      </div>
    </div>
    ${blocos}
    </body></html>`;
}

function sepImprimirPedido(pedidoId) {
  const p = _sepPedidos.find((x) => x.id === pedidoId);
  if (!p) return;
  const win = window.open("", "_blank", "width=800,height=700");
  win.document.write(_sepGerarHtmlImpressao([p]));
  win.document.close();
}

function sepImprimirTudo() {
  if (!_sepPedidos.length) {
    alert("Nenhum pedido para imprimir.");
    return;
  }
  const win = window.open("", "_blank", "width=800,height=700");
  win.document.write(_sepGerarHtmlImpressao(_sepPedidos));
  win.document.close();
}

// Ícone por forma de pagamento
function _sepIconePgto(forma) {
  const m = {
    efectivo: "💵",
    dinheiro: "💵",
    cartao: "💳",
    pix: "⚡",
    transferencia: "🏦",
    qr_py: "📱",
  };
  return m[(forma || "").toLowerCase().replace(/\s/g, "")] || "💰";
}

// =========================================
// 6. FINANCEIRO
// =========================================
// Estado persistente do último cálculo financeiro
let _caixaState = {
  faturamento: 0,
  custoEntregas: 0,
  totalSaidas: 0,
  totalEntradas: 0,
  totalPix: 0,
  totalTransf: 0,
  totalCartao: 0,
  totalEfetivo: 0,
  totalQrPy: 0,
  totalCartaoBR: 0,
  totalMultiOutros: 0,
  totalNaNotaAberto: 0,
  qtdPedidos: 0,
};

// Sessão de caixa ativa (carregada ao abrir a aba financeiro)
let _sessaoCaixaAtiva = null;
// { id, usuario_email, aberto_em, fechado_em, valor_abertura }

// ─────────────────────────────────────────────────────────────
// HORA DO SERVIDOR (Edge Function `server-time`)
// Evita que o relógio do dispositivo do operador (que pode estar
// errado ou ser manipulado de propósito) determine em que dia uma
// venda ou abertura/fechamento de caixa é contabilizada.
// Faz cache curto (10s) para não bater na function a cada clique.
// ─────────────────────────────────────────────────────────────
let _horaServidorCache = null; // { iso, ts, date_py, time_py, buscadoEm }

async function _obterHoraServidor() {
  const AGORA_MS = Date.now();
  if (_horaServidorCache && AGORA_MS - _horaServidorCache.buscadoEm < 10000) {
    return _horaServidorCache;
  }
  try {
    const supaUrl =
      window._SUPABASE_URL ||
      (typeof _SUPABASE_URL !== "undefined" ? _SUPABASE_URL : "");
    if (!supaUrl) throw new Error("Supabase URL indisponível");
    const fnUrl =
      supaUrl.replace("/rest/v1", "").replace(/\/+$/, "") +
      "/functions/v1/server-time";
    const resp = await fetch(fnUrl, { method: "GET" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    _horaServidorCache = { ...data, buscadoEm: AGORA_MS };
    return _horaServidorCache;
  } catch (e) {
    console.warn("⚠️ Falha ao obter hora do servidor, usando relógio local como fallback:", e.message);
    // Fallback: hora local do dispositivo, ajustada "manualmente" para UTC-3
    // (Paraguai é UTC-3 permanente desde 2024 — ver server-time/index.ts)
    const now = new Date();
    const nowPy = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const fallback = {
      iso: now.toISOString(),
      ts: now.getTime(),
      date_utc: now.toISOString().slice(0, 10),
      date_py: nowPy.toISOString().slice(0, 10),
      time_py: nowPy.toISOString().slice(11, 19),
      offset: "-03:00",
      buscadoEm: AGORA_MS,
      _fallbackLocal: true,
    };
    _horaServidorCache = fallback;
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────
// GERENCIAMENTO DE SESSÃO DE CAIXA
// ─────────────────────────────────────────────────────────────

/**
 * Carrega a sessão de caixa ativa para o usuário corrente.
 * Gestores veem qualquer sessão aberta (ou a mais recente).
 * Funcionário vê apenas a sua própria.
 */
async function _carregarSessaoCaixa() {
  const ehGestor = ["dono", "gerente", "adminMaster"].includes(perfilUsuario);
  const emailAtual = document.getElementById("user-email")?.innerText || "";

  let q = supa
    .from("sessoes_caixa")
    .select("*")
    .is("fechado_em", null) // só sessões ABERTAS
    .order("aberto_em", { ascending: false })
    .limit(1);

  if (!ehGestor) q = q.eq("usuario_email", emailAtual);

  const { data } = await q;
  _sessaoCaixaAtiva = data?.[0] || null;

  // Atualiza o indicador visual de status do caixa (se existir no HTML)
  const elStatus = document.getElementById("status-sessao-caixa");
  if (elStatus) {
    if (_sessaoCaixaAtiva) {
      const dAbr = new Date(_sessaoCaixaAtiva.aberto_em).toLocaleString(
        "pt-BR",
        {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        },
      );
      elStatus.innerHTML = `<span style="color:#27ae60">🟢 Caixa aberto desde ${dAbr}</span>`;
    } else {
      elStatus.innerHTML = `<span style="color:#e74c3c">🔴 Nenhum caixa aberto</span>`;
    }
  }
}

/**
 * Exibe alerta de abertura de caixa e abre o modal para registro.
 */
function _exibirAlertaAberturaCaixa() {
  const ehGestor = ["dono", "gerente", "adminMaster"].includes(perfilUsuario);
  const msg = ehGestor
    ? "⚠️ Nenhuma sessão de caixa está aberta no momento.\n\nDeseja abrir o caixa agora?"
    : "⚠️ Você ainda não abriu o caixa hoje.\n\nÉ necessário registrar a abertura para contabilizar as vendas nesta sessão.\n\nDeseja abrir o caixa agora?";

  if (confirm(msg)) {
    abrirModalCaixa("abertura");
  }
}

/**
 * Abre nova sessão de caixa no Supabase e carrega em _sessaoCaixaAtiva.
 * Chamado ao salvar uma movimentação do tipo "abertura".
 */
async function _abrirSessaoCaixa(valorAbertura, descricao) {
  const emailAtual = document.getElementById("user-email")?.innerText || "";
  const nome =
    document.getElementById("user-nome-display")?.innerText || emailAtual;

  // Usa hora do servidor (não o relógio do dispositivo) para o timestamp
  // de abertura, evitando que alguém manipule o horário local do PC/celular.
  const horaServ = await _obterHoraServidor();

  const { data, error } = await supa
    .from("sessoes_caixa")
    .insert([
      {
        usuario_email: emailAtual,
        usuario_nome: nome,
        aberto_em: horaServ.iso,
        valor_abertura: valorAbertura || 0,
        observacao: descricao || null,
      },
    ])
    .select()
    .single();

  if (error) throw error;
  _sessaoCaixaAtiva = data;
  return data;
}

// ─────────────────────────────────────────────────────────────
// HELPER — offset UTC de Assunção em ms para uma data específica
// Desde 2024 o Paraguai adotou UTC-3 permanente (sem horário de verão).
// Usamos Intl.DateTimeFormat com "America/Asuncion" para que a IANA tz
// database reflita automaticamente qualquer futura mudança de lei.
// ─────────────────────────────────────────────────────────────
function _getAsuncionOffsetMs(date) {
  try {
    // Determina o offset real comparando UTC com o horário local de Assunção
    const utc = date.getTime();
    const localStr = new Intl.DateTimeFormat("sv-SE", {
      // sv-SE = formato ISO sem vírgula
      timeZone: "America/Asuncion",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
    const local = new Date(localStr);
    return utc - local.getTime();
  } catch (_) {
    return 3 * 60 * 60 * 1000; // fallback UTC-3 (permanente desde 2024)
  }
}

/**
 * Determina a janela de tempo (UTC) a usar para consultas do
 * Financeiro — usada tanto pela tela (calcularFinanceiro) quanto
 * pelas exportações (CSV/PDF), para que os dois NUNCA divirjam.
 *
 * Prioridade:
 *  a) Gestor filtrou datas manualmente na tela → usa esse intervalo
 *     (útil para consultar dias passados).
 *  b) Existe uma sessão de caixa ABERTA e nenhum filtro manual →
 *     usa a JANELA REAL da sessão (aberto_em até agora), e NÃO o
 *     dia do calendário. Isso é o que garante que vendas feitas
 *     depois da meia-noite, com o caixa ainda aberto, continuem
 *     contabilizadas no dia em que o caixa foi aberto.
 *  c) Sem sessão aberta e sem filtro manual → usa o dia de hoje
 *     (servidor), das 00:00 às 23:59 (fuso de Assunção).
 */
async function _janelaFinanceiroAtual() {
  const elInicio = document.getElementById("fin-inicio");
  const elFim = document.getElementById("fin-fim");
  const ehGestor = ["dono", "gerente", "adminMaster"].includes(perfilUsuario);

  await _carregarSessaoCaixa();
  const horaServ = await _obterHoraServidor();
  const hoje = horaServ.date_py;

  let utcI, utcF;
  const filtroManual = ehGestor && elInicio?.value && elFim?.value;

  if (filtroManual) {
    const _refDate = new Date(elInicio.value + "T12:00:00");
    const _asunOffset = _getAsuncionOffsetMs(_refDate);
    utcI = new Date(new Date(elInicio.value + "T00:00:00").getTime() + _asunOffset).toISOString();
    utcF = new Date(new Date(elFim.value + "T23:59:59").getTime() + _asunOffset).toISOString();
  } else if (_sessaoCaixaAtiva) {
    // Janela real da sessão de caixa — não do calendário. Importante:
    // NÃO escrevemos em elInicio.value/elFim.value aqui. Se fizéssemos,
    // na próxima chamada esses campos apareceriam preenchidos e o ramo
    // "filtroManual" acima passaria a ser usado por engano — travando
    // a janela na data em que essa escrita aconteceu e reintroduzindo
    // o mesmo bug de vendas "sumirem" após a virada da meia-noite.
    utcI = _sessaoCaixaAtiva.aberto_em;
    utcF = _sessaoCaixaAtiva.fechado_em || horaServ.iso;
  } else {
    // Sem sessão de caixa aberta: como tela de RELATÓRIO (diferente da
    // reconciliação ao vivo do caso acima), o padrão precisa ser mais
    // generoso que "só hoje" — senão, assim que o caixa é fechado (ou
    // ainda não foi aberto de novo), tudo que veio antes "some" da
    // visão padrão mesmo estando intacto no banco. Usamos os últimos
    // 7 dias como padrão; gestores continuam podendo escolher qualquer
    // intervalo manualmente (ramo "filtroManual" acima).
    const _refDateFim = new Date(hoje + "T12:00:00");
    const _asunOffsetFim = _getAsuncionOffsetMs(_refDateFim);
    const _seteDiasAtras = new Date(_refDateFim.getTime() - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const _asunOffsetIni = _getAsuncionOffsetMs(new Date(_seteDiasAtras + "T12:00:00"));
    utcI = new Date(new Date(_seteDiasAtras + "T00:00:00").getTime() + _asunOffsetIni).toISOString();
    utcF = new Date(new Date(hoje + "T23:59:59").getTime() + _asunOffsetFim).toISOString();
    // Só preenche os campos de exibição para quem NÃO é gestor — para
    // gestores, escrever aqui faria a próxima chamada cair no ramo
    // "filtroManual" por engano (mesmo risco de janela travada/stale).
    // Gestores só entram em modo manual escolhendo a data eles mesmos.
    if (!ehGestor && elInicio && elFim) {
      if (!elInicio.value) elInicio.value = hoje;
      if (!elFim.value) elFim.value = hoje;
    }
  }

  return { utcI, utcF, hoje, ehGestor };
}

async function calcularFinanceiro() {
  const abaFin = document.getElementById("financeiro");
  if (!abaFin || !abaFin.classList.contains("active")) return;

  const elInicio = document.getElementById("fin-inicio");
  const elFim = document.getElementById("fin-fim");
  const elTipo = document.getElementById("fin-tipo");
  const elFactura = document.getElementById("fin-factura");
  if (!elInicio || !elFim || !elTipo) return;

  const emailAtual = document.getElementById("user-email")?.innerText || "";

  // Determina a janela de tempo (sessão de caixa / filtro manual / hoje)
  // usando hora do servidor — nunca o relógio do dispositivo.
  const { utcI, utcF, ehGestor } = await _janelaFinanceiroAtual();

  const tipoFiltro = elTipo.value;
  const facturaFiltro = elFactura ? elFactura.value : "todos";

  // ── 4. Busca pedidos dentro da janela da sessão ───────────────────
  // Inclui TODOS os status exceto cancelado — pedidos do app chegam como
  // "pendente" ou "em_preparo" e devem ser contabilizados no caixa do dia.
  let query = supa
    .from("pedidos")
    .select("*, motoboys(nome)")
    .neq("status", "cancelado")
    .gte("created_at", utcI)
    .lte("created_at", utcF);

  if (tipoFiltro !== "todos") query = query.eq("forma_pagamento", tipoFiltro);

  // Funcionário: filtra apenas pedidos relacionados ao seu usuário
  // (via mesa/operador, se seu schema tiver esse campo — ajuste o campo se necessário)
  // if (!ehGestor) query = query.eq("operador_email", emailAtual);

  const { data: pedidos } = await query;
  let peds = pedidos || [];

  if (facturaFiltro === "com_factura")
    peds = peds.filter((p) => p.dados_factura?.ruc || p.dados_factura?.ci);
  else if (facturaFiltro === "sem_factura")
    peds = peds.filter((p) => !p.dados_factura?.ruc && !p.dados_factura?.ci);

  // ── 5. Movimentações de caixa da SESSÃO ──────────────────────────
let caixa = [];
if (_sessaoCaixaAtiva) {
  let caixaQuery = supa
    .from("movimentacoes_caixa")
    .select("*")
    .eq("sessao_id", _sessaoCaixaAtiva.id);
  if (!ehGestor) caixaQuery = caixaQuery.eq("usuario_email", emailAtual);
  const { data: caixaData } = await caixaQuery;
  caixa = caixaData || [];
}

  // Verifica bloqueio de caixa (sangria limite)
  _verificarBloqueioCaixa(emailAtual);

  // ── 6. Cálculos (inalterado) ──────────────────────────────────────
  const safeNum = (v) => {
    if (!v) return 0;
    if (typeof v === "number") return v;
    return (
      parseFloat(
        v
          .toString()
          .replace(/[^\d.,-]/g, "")
          .replace(",", "."),
      ) || 0
    );
  };
  const fmt = (n) => "Gs " + n.toLocaleString("es-PY");

  let faturamento = 0,
    totalPix = 0,
    totalTransf = 0,
    totalCartao = 0,
    totalEfetivo = 0,
    totalQrPy = 0,
    totalCartaoBR = 0,
    totalMultiOutros = 0,
    totalNaNotaAberto = 0;
  let custoEntregas = 0,
    qtdPedidos = 0,
    qtdNaNotaAberto = 0;
  const motoMap = {};

  peds.forEach((p) => {
    const val = safeNum(p.total_geral);
    qtdPedidos++;
    let pag = (p.forma_pagamento || "").toLowerCase();
    const obsPag = p.obs_pagamento || "";

    // ── Na Nota: o campo forma_pagamento fica gravado como "NaNota" para
    //    sempre, mesmo depois de quitado — a forma REAL usada na quitação
    //    vai para forma_pagamento_quitacao, que antes não era lida aqui.
    //    Enquanto em aberto, é dívida do cliente (não dinheiro recebido),
    //    então fica de fora do faturamento e é contabilizada à parte.
    if (pag === "nanota") {
      if (p.quitado_em && p.forma_pagamento_quitacao) {
        pag = p.forma_pagamento_quitacao.toLowerCase();
      } else {
        totalNaNotaAberto += val;
        qtdNaNotaAberto++;
        return; // não soma no faturamento nem em nenhuma forma de pagamento
      }
    }

    faturamento += val;

    // ── Multipagamento: distribui pelos métodos reais gravados em obs_pagamento ──
    if (pag === "multipagamento" && obsPag) {
      try {
        const partes = JSON.parse(obsPag); // [{ metodo, valor }, ...] — campo legado: forma
        if (Array.isArray(partes)) {
          partes.forEach((parte) => {
            const pf = (parte.metodo || parte.forma || "").toLowerCase();
            const pv = Math.round(Number(parte.valor) || 0);
            if (pf.includes("pix"))                                   totalPix     += pv;
            else if (pf.includes("transfer"))                         totalTransf  += pv;
            else if (pf.includes("qrpy") || pf.includes("qr"))       totalQrPy    += pv;
            else if (pf.includes("cartaobr") || pf.includes("br"))   totalCartaoBR+= pv;
            else if (pf.includes("cartao") || pf.includes("cartão")) totalCartao  += pv;
            else                                                       totalEfetivo += pv;
          });
        } else {
          totalMultiOutros += val; // JSON malformado — conta separado
        }
      } catch (_) {
        totalMultiOutros += val; // obs_pagamento não é JSON (texto livre)
      }
    }
    // ── Pagamentos simples ──────────────────────────────────────────────────
    else if (pag.includes("pix"))                                    totalPix     += val;
    else if (pag.includes("transfer") || pag.includes("alias"))     totalTransf  += val;
    else if (pag === "qrpy")                                         totalQrPy    += val;
    else if (pag === "cartaobr")                                     totalCartaoBR+= val;
    else if (pag.includes("cartao") || pag.includes("cartão"))      totalCartao  += val;
    else if (pag.includes("efetivo") || pag.includes("dinheiro"))   totalEfetivo += val;
    else                                                             totalMultiOutros += val;
    if (p.tipo_entrega === "delivery") {
      const taxa = safeNum(p.frete_motoboy) || TAXA_MOTOBOY || 0;
      custoEntregas += taxa;
      const nm = p.motoboys?.nome || "Sem Motoboy";
      if (!motoMap[nm]) motoMap[nm] = { entregas: 0, frete_total: 0 };
      motoMap[nm].entregas++;
      motoMap[nm].frete_total += taxa;
    }
  });

  const qtdMotoboyUnicos = Object.keys(motoMap).filter(
    (n) => n !== "Sem Motoboy",
  ).length;
  custoEntregas += (AJUDA_COMBUSTIVEL || 0) * qtdMotoboyUnicos;

  // ── Lucro sobre Vendas (usando preco_compra cadastrado nos produtos) ──
  // ATENÇÃO: este cálculo só considera itens cujo produto tem preco_compra
  // cadastrado. Itens SEM preco_compra são excluídos do cálculo (não dá
  // pra estimar lucro sem custo) — mas isso significa que o markup exibido
  // é uma média APENAS dos produtos com custo cadastrado, não de 100% das
  // vendas. Por isso agora rastreamos e exibimos a cobertura (% do
  // faturamento que entrou no cálculo), para não dar falsa precisão.
  let lucroBrutoVendas = 0;
  let markupMedioVendas = null;
  let faturamentoComCusto = 0;
  let faturamentoSemCusto = 0;
  let qtdItensSemCusto = 0;
  try {
    const prodIdsSet = new Set();
    peds.forEach((p) => {
      (p.itens || []).forEach((i) => {
        const pid = i.produto_id || i.id || i.pid;
        if (pid) prodIdsSet.add(Number(pid));
      });
    });
    const prodIds = Array.from(prodIdsSet);
    let precosCompra = {};
    if (prodIds.length > 0) {
      const { data: prods } = await supa
        .from("produtos")
        .select("id, preco_compra")
        .in("id", prodIds);
      (prods || []).forEach((pr) => {
        if (pr.preco_compra) precosCompra[pr.id] = pr.preco_compra;
      });
    }
    let custoTotal = 0;
    peds.forEach((p) => {
      (p.itens || []).forEach((i) => {
        const pid = Number(i.produto_id || i.id || i.pid || 0);
        const qtd = i.qtd || i.q || 1;
        const precoVenda = safeNum(i.preco || i.p || 0);
        const precoCompra = precosCompra[pid] || 0;
        const valorItem = precoVenda * qtd;
        if (precoVenda > 0 && precoCompra > 0) {
          lucroBrutoVendas += (precoVenda - precoCompra) * qtd;
          custoTotal += precoCompra * qtd;
          faturamentoComCusto += valorItem;
        } else if (precoVenda > 0) {
          // Item vendido mas sem preco_compra cadastrado — fica de fora
          // do cálculo de lucro. Contabiliza para mostrar a cobertura real.
          faturamentoSemCusto += valorItem;
          qtdItensSemCusto++;
        }
      });
    });
    if (custoTotal > 0)
      markupMedioVendas = Math.round((lucroBrutoVendas / custoTotal) * 100);
  } catch (e) {
    console.warn("Erro calcular lucro vendas:", e);
  }

  // % do faturamento de itens que efetivamente entrou no cálculo de lucro
  const _baseCobertura = faturamentoComCusto + faturamentoSemCusto;
  const coberturaLucroPct =
    _baseCobertura > 0
      ? Math.round((faturamentoComCusto / _baseCobertura) * 100)
      : null;

  let totalSaidas = 0,
    totalEntradas = 0,
    totalSangria = 0;
  (caixa || []).forEach((c) => {
    const v = safeNum(c.valor);
    if (c.tipo === "despesa") totalSaidas += v;
    if (c.tipo === "sangria") {
      totalSaidas += v;
      totalSangria += v;
    }
    if (c.tipo === "suprimento" || c.tipo === "abertura") totalEntradas += v;
  });

  _caixaState = {
    faturamento,
    custoEntregas,
    totalSaidas,
    totalEntradas,
    totalPix,
    totalTransf,
    totalCartao,
    totalEfetivo,
    totalQrPy,
    totalCartaoBR,
    totalMultiOutros,
    totalNaNotaAberto,
    qtdPedidos,
    qtdNaNotaAberto,
    totalSangria,
    lucroBrutoVendas: lucroBrutoVendas || 0,
    markupMedioVendas,
    coberturaLucroPct,
    faturamentoSemCusto,
    qtdItensSemCusto,
  };

  const lucro = faturamento + totalEntradas - custoEntregas - totalSaidas;
  const setV = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.innerText = v;
  };

  setV("card-faturamento", fmt(faturamento));
  setV("card-custo-moto", fmt(custoEntregas));
  setV("card-lucro", fmt(lucro));
  setV("card-lucro-vendas", fmt(lucroBrutoVendas || 0));
  const elLvPct = document.getElementById("card-lucro-vendas-pct");
  if (elLvPct) {
    // Avisa quando o markup foi calculado sobre só uma fração das vendas
    // (produtos sem preco_compra cadastrado ficam fora da conta) — isso
    // evita comparar números de cobertura diferente entre lojas/sistemas
    // e achar que o lucro "não bate" quando na verdade é a base de cálculo
    // que é diferente.
    const avisoCobertura =
      coberturaLucroPct !== null && coberturaLucroPct < 95
        ? ` · cálculo cobre só ${coberturaLucroPct}% das vendas (${qtdItensSemCusto} item(s) sem custo cadastrado)`
        : "";
    if (lucroBrutoVendas > 0 && markupMedioVendas !== null) {
      elLvPct.style.color = coberturaLucroPct !== null && coberturaLucroPct < 95 ? "#d97706" : "#388e3c";
      elLvPct.textContent = `markup médio ${markupMedioVendas}%${avisoCobertura}`;
      elLvPct.title = avisoCobertura
        ? `Faturamento sem custo cadastrado: ${fmt(faturamentoSemCusto)}. Cadastre o "preço de compra" nesses produtos para um markup mais preciso.`
        : "";
    } else if (lucroBrutoVendas > 0) {
      elLvPct.textContent = `com base nos custos${avisoCobertura}`;
    } else {
      elLvPct.style.color = "#9ca3af";
      elLvPct.textContent = "cadastre o preço de compra nos produtos";
    }
  }
  setV("total-pix", fmt(totalPix));
  setV("total-transf", fmt(totalTransf));
  setV("total-cartao", fmt(totalCartao));
  setV("total-efetivo", fmt(totalEfetivo));
  setV("total-qrpy", fmt(totalQrPy));
  setV("total-cartaobr", fmt(totalCartaoBR));
  setV("total-multi-outros", fmt(totalMultiOutros));
  setV("total-nanota-aberto", fmt(totalNaNotaAberto));
  setV("card-qtd-pedidos", qtdPedidos);
  setV(
    "card-ticket-medio",
    fmt(qtdPedidos - qtdNaNotaAberto > 0 ? faturamento / (qtdPedidos - qtdNaNotaAberto) : 0),
  );

  // Badge do operador / info da sessão
  const badgeCaixa = document.getElementById("badge-caixa-operador");
if (badgeCaixa) {
  if (_sessaoCaixaAtiva) {
    const dAbr = new Date(_sessaoCaixaAtiva.aberto_em).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dFch = _sessaoCaixaAtiva.fechado_em
      ? new Date(_sessaoCaixaAtiva.fechado_em).toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "em aberto";
    badgeCaixa.textContent = ehGestor
      ? `📊 Visão geral — sessão ${_sessaoCaixaAtiva.id} (${_sessaoCaixaAtiva.usuario_email}) · ${dAbr} → ${dFch}`
      : `💼 Seu caixa — aberto ${dAbr} → ${dFch}`;
  } else {
    badgeCaixa.textContent = "📊 Sem sessão de caixa ativa — exibindo todos os pedidos do período";
  }
}

  // Tabelas de despesas e motoboys (código original preservado)
  const tbD = document.getElementById("lista-despesas-caixa");
  if (tbD) {
    const despesas = (caixa || []).filter((c) => c.tipo === "despesa");
    const _DLABELS = {
      despesas_gerais: "📦 Despesas Gerais",
      contas_fixas: "🏠 Contas Fixas",
      pagamento_fornecedor: "🤝 Fornecedor",
      pagamento_funcionario: "👷 Funcionário",
      pagamento_terceiros: "👥 Terceiros",
      manutencao: "🔧 Manutenção",
      retirada: "💵 Retirada",
      motoboy: "🛵 Motoboy",
      outro: "✏️ Outro",
    };
    if (!despesas.length) {
      tbD.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#999;padding:16px">Nenhuma despesa nesta sessão</td></tr>';
    } else {
      tbD.innerHTML = despesas
        .map((d) => {
          const dt = new Date(d.created_at).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          const tipoLabel = _DLABELS[d.tipo_despesa] || d.tipo_despesa || "—";
          const descExtra =
            d.tipo_despesa === "outro" && d.descricao_outro
              ? ` (${d.descricao_outro})`
              : "";
          const obs = d.descricao || "";
          const enc = encodeURIComponent(
            JSON.stringify({
              id: d.id,
              valor: d.valor,
              tipo_despesa: d.tipo_despesa || "despesas_gerais",
              descricao: d.descricao || "",
              descricao_outro: d.descricao_outro || "",
            }),
          );
          return `<tr>
          <td style="white-space:nowrap;color:#666;font-size:0.82rem">${dt}</td>
          <td><span style="background:#fdecea;color:#a93226;padding:2px 7px;border-radius:10px;font-size:0.78rem">${tipoLabel}${descExtra}</span></td>
          <td style="color:#555;font-size:0.85rem">${obs}</td>
          <td style="text-align:right;font-weight:700;color:#c0392b;white-space:nowrap">${fmt(d.valor)}</td>
          <td style="text-align:center;white-space:nowrap">
            <button onclick="abrirEditarDespesa('${enc}')" style="background:#3498db;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem;margin-right:4px">✏️</button>
            <button onclick="excluirDespesa(${d.id})" style="background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem">🗑️</button>
          </td></tr>`;
        })
        .join("");
    }
  }

  const tbM = document.getElementById("lista-financeiro-motoboys");
  if (tbM) {
    tbM.innerHTML = "";
    if (!Object.keys(motoMap).length) {
      tbM.innerHTML =
        '<tr><td colspan="4" style="text-align:center;color:#999">Nenhuma entrega nesta sessão</td></tr>';
    } else {
      for (const [nome, d] of Object.entries(motoMap)) {
        const semNome = nome === "Sem Motoboy";
        const comb = semNome ? 0 : AJUDA_COMBUSTIVEL || 0;
        const tot = d.frete_total + comb;
        const combLabel = semNome
          ? '<span style="color:#aaa;font-size:0.78rem">sem combustível</span>'
          : `+ comb. ${fmt(comb)}`;
        tbM.innerHTML += `<tr><td>${nome}</td><td>${d.entregas}</td>
          <td style="font-size:0.82rem">Frete: ${fmt(d.frete_total)} ${combLabel}</td>
          <td><strong>${fmt(tot)}</strong></td></tr>`;
      }
    }
  }

  // ── Relatório Detalhado de Vendas: popula com os pedidos já carregados ──
  // Não faz nova query ao banco — reutiliza `peds` (já filtrados por data e forma de pagamento).
  // Busca sessões de caixa fechadas que se sobrepõem à janela, para linkar
  // o botão "Ver boletim de fechamento" em cada grupo de dia.
  let sessoesDoPeriodo = [];
  try {
    const { data: sessoesData } = await supa
      .from("sessoes_caixa")
      .select("id, aberto_em, fechado_em")
      .not("fechado_em", "is", null)
      .lte("aberto_em", utcF)
      .gte("fechado_em", utcI);
    sessoesDoPeriodo = sessoesData || [];
  } catch (_) {
    sessoesDoPeriodo = [];
  }
  _finRelPopular(peds, sessoesDoPeriodo);
}

// ══════════════════════════════════════════════════════════════════
// RELATÓRIO DETALHADO DE VENDAS  (aba Financeiro)
// ── Integrado com calcularFinanceiro(): reutiliza utcI/utcF e
//    tipoFiltro já resolvidos; chamado no final de calcularFinanceiro.
// ══════════════════════════════════════════════════════════════════

/** Estado interno do relatório — isolado do restante do módulo */
const _finRel = {
  linhas: [],          // todas as linhas expandidas (1 por item × pedido)
  linhasFiltradas: [], // subconjunto após busca livre
  pagina: 0,
  PAGE_SIZE: 50,
  aberto: false,       // painel colapsado por padrão
  sessoes: [],          // sessões de caixa fechadas no período (p/ boletim por dia)
  diasColapsados: {},   // { 'YYYY-MM-DD': true } — dias recolhidos pelo usuário
};

/**
 * Ponto de entrada: chamado ao final de calcularFinanceiro().
 * Recebe os mesmos pedidos já carregados para evitar segunda query.
 *
 * @param {Array} peds     - array de pedidos já filtrados
 * @param {Array} sessoes  - sessões de caixa fechadas que tocam o período
 */
function _finRelPopular(peds, sessoes) {
  // Expande cada pedido em N linhas (uma por item)
  const fmt = (n) => "Gs " + Math.round(n).toLocaleString("es-PY");

  const linhas = [];
  (peds || []).forEach((p) => {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const dataObj = new Date(p.created_at);
    const dataHora = dataObj.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    // Dia local de Assunção (YYYY-MM-DD) — usado para agrupar por dia
    const _offDia = _getAsuncionOffsetMs(dataObj);
    const dataDia = new Date(dataObj.getTime() - _offDia).toISOString().slice(0, 10);

    const pedidoLabel = `#${p.id}`;
    const cliente    = p.cliente_nome || "—";

    // Forma de pagamento — resolve multipagamento e Na Nota quitado
    let pgtoLabel;
    let pagEfetivo = (p.forma_pagamento || "").toLowerCase();
    if (pagEfetivo === "nanota" && p.quitado_em && p.forma_pagamento_quitacao) {
      pagEfetivo = p.forma_pagamento_quitacao.toLowerCase();
    }
    const obsPag = p.obs_pagamento || "";
    if (pagEfetivo === "multipagamento" && obsPag) {
      try {
        const partes = JSON.parse(obsPag);
        if (Array.isArray(partes)) {
          pgtoLabel = partes
            .map((pt) => { const m = pt.metodo || pt.forma || "—"; return `${_sepIconePgto(m)} ${m} (Gs ${Math.round(Number(pt.valor) || 0).toLocaleString("es-PY")})`; })
            .join(" + ");
        } else {
          pgtoLabel = p.forma_pagamento || "—";
        }
      } catch (_) {
        pgtoLabel = p.forma_pagamento || "—";
      }
    } else if ((p.forma_pagamento || "").toLowerCase() === "nanota" && !(p.quitado_em && p.forma_pagamento_quitacao)) {
      pgtoLabel = "📋 Na Nota (em aberto)";
    } else {
      pgtoLabel = `${_sepIconePgto(pagEfetivo)} ${p.forma_pagamento_quitacao || p.forma_pagamento || "—"}`;
    }

    if (!itens.length) {
      // Pedido sem itens — inclui uma linha representando o total
      linhas.push({
        pedidoLabel, dataHora, dataDia, cliente,
        nome: "(sem itens)", qtd: "—",
        vlUnit: "—", subtotal: fmt(p.total_geral || 0),
        pgtoLabel, pedidoId: p.id,
        _subtotalNum: p.total_geral || 0,
        _pagEfetivo: pagEfetivo,
      });
      return;
    }

    itens.forEach((item) => {
      const qtd     = item.qtd  || item.q  || 1;
      const nome    = item.nome || item.n  || "Item";
      const vlUnit  = item.preco || item.p  || 0;
      const variacao = item.variacao ? ` (${item.variacao})` : "";
      linhas.push({
        pedidoLabel, dataHora, dataDia, cliente,
        nome: nome + variacao,
        qtd,
        vlUnit: fmt(vlUnit),
        subtotal: fmt(vlUnit * qtd),
        pgtoLabel, pedidoId: p.id,
        _subtotalNum: vlUnit * qtd,
        _pagEfetivo: pagEfetivo,
      });
    });
  });

  _finRel.linhas = linhas;
  _finRel.sessoes = sessoes || [];
  _finRel.pagina = 0;

  // Aplica filtro de busca livre (mantém o que o usuário já digitou)
  _finRelFiltrarTabela();

  // Atualiza o badge com a contagem total de linhas
  const elContador = document.getElementById("fin-rel-contador");
  if (elContador) {
    elContador.textContent = `${linhas.length} linha${linhas.length !== 1 ? "s" : ""}`;
    elContador.style.display = linhas.length ? "inline" : "none";
  }
}

/**
 * Filtra _finRel.linhas pela busca livre e re-renderiza.
 * Chamada pelo oninput do campo de busca e por _finRelPopular.
 */
function _finRelFiltrarTabela() {
  const busca = (document.getElementById("fin-rel-busca")?.value || "").toLowerCase().trim();

  _finRel.linhasFiltradas = busca
    ? _finRel.linhas.filter(
        (l) =>
          l.nome.toLowerCase().includes(busca) ||
          l.cliente.toLowerCase().includes(busca) ||
          l.pedidoLabel.toLowerCase().includes(busca)
      )
    : [..._finRel.linhas];

  _finRel.pagina = 0;
  _finRelRenderizar();
}

/**
 * Renderiza a tabela agrupada por dia (dia local de Assunção) e
 * atualiza os totalizadores. Cada dia é uma seção recolhível, com
 * chips de forma de pagamento, total do dia e — quando há uma
 * sessão de caixa fechada naquele dia — um botão para reabrir o
 * boletim de fechamento persistido (abrirRelatorioFechamento).
 */
function _finRelRenderizar() {
  const tbody = document.getElementById("fin-rel-tbody");
  const paginacaoEl = document.getElementById("fin-rel-paginacao");
  if (!tbody) return;
  if (paginacaoEl) paginacaoEl.style.display = "none"; // substituído pelos grupos por dia

  const { linhasFiltradas } = _finRel;
  const fmt = (n) => "Gs " + Math.round(n || 0).toLocaleString("es-PY");

  if (!linhasFiltradas.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#bbb;padding:24px;font-size:0.85rem;">
      Nenhum item encontrado para os filtros aplicados.
    </td></tr>`;
    _finRelAtualizarTotais([]);
    return;
  }

  // Agrupa por dia (dataDia já vem calculada em Assunção local)
  const porDia = {};
  linhasFiltradas.forEach((l) => {
    (porDia[l.dataDia] ||= []).push(l);
  });
  const dias = Object.keys(porDia).sort().reverse(); // mais recente primeiro

  const mapaChip = {
    efetivo: ["💵 Efetivo", "#856404"],
    dinheiro: ["💵 Efetivo", "#856404"],
    cartao: ["💳 Cartão", "#0c5460"],
    pix: ["📱 Pix", "#155724"],
    transferencia: ["🏦 Transferência", "#383d41"],
    alias: ["🏦 Transferência", "#383d41"],
    qrpy: ["📲 QR Paraguay", "#1a5276"],
    cartaobr: ["💳🇧🇷 Cartão BR", "#117a65"],
  };

  let html = "";
  dias.forEach((dia, idxDia) => {
    const linhasDia = porDia[dia];
    const pedidosUnicos = new Set(linhasDia.map((l) => l.pedidoId));
    const totalDia = linhasDia.reduce((s, l) => s + (l._subtotalNum || 0), 0);

    // Agrega por forma de pagamento — soma pelo subtotal de cada LINHA
    // (item); como todo item de um pedido tem a mesma forma de pagamento,
    // isso equivale a somar por pedido, sem risco de dupla contagem.
    const totaisPorForma = {};
    linhasDia.forEach((l) => {
      const key = (l._pagEfetivo || "outros").replace(/[^a-z]/g, "");
      const chaveMapa = Object.keys(mapaChip).find((k) => key.includes(k)) || "outros";
      totaisPorForma[chaveMapa] = (totaisPorForma[chaveMapa] || 0) + (l._subtotalNum || 0);
    });

    const chips = Object.entries(totaisPorForma)
      .filter(([k, v]) => k !== "outros" && v > 0)
      .map(([k, v]) => {
        const [label, cor] = mapaChip[k] || ["Outros", "#666"];
        return `<span style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:3px 8px;font-size:0.74rem;color:${cor};white-space:nowrap;">${label} ${fmt(v)}</span>`;
      })
      .join("");

    // Data formatada (dd/mm/aaaa) a partir de 'YYYY-MM-DD'
    const [ano, mes, diaNum] = dia.split("-");
    const dataFormatada = `${diaNum}/${mes}/${ano}`;

    // Sessão de caixa fechada nesse dia (se houver) → botão de boletim
    const sessaoDoDia = (_finRel.sessoes || []).find((s) => {
      const off = _getAsuncionOffsetMs(new Date(s.aberto_em));
      const diaSessao = new Date(new Date(s.aberto_em).getTime() - off).toISOString().slice(0, 10);
      return diaSessao === dia;
    });

    // Por padrão, só o dia mais recente vem aberto
    if (!(dia in _finRel.diasColapsados)) _finRel.diasColapsados[dia] = idxDia !== 0;

    html += `
      <tr class="fin-rel-dia-header" style="background:#eef2f7;cursor:pointer;" onclick="_finRelToggleDia('${dia}')">
        <td colspan="8" style="padding:10px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:160px;">
              <i class="fas fa-chevron-${_finRel.diasColapsados[dia] ? "down" : "up"}" style="font-size:0.75rem;color:#888;"></i>
              <strong style="font-size:0.88rem;">📅 ${dataFormatada}</strong>
              <span style="color:#888;font-size:0.76rem;">${pedidosUnicos.size} venda${pedidosUnicos.size !== 1 ? "s" : ""}</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;flex:1;">${chips}</div>
            <div style="display:flex;align-items:center;gap:10px;white-space:nowrap;">
              <strong style="color:#2d6a4f;font-size:0.9rem;">Total: ${fmt(totalDia)}</strong>
              ${sessaoDoDia ? `<button onclick="event.stopPropagation(); abrirRelatorioFechamento(${sessaoDoDia.id})"
                style="background:#2c3e50;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:0.74rem;cursor:pointer;white-space:nowrap;">
                📋 Boletim de Fechamento</button>` : ""}
            </div>
          </div>
        </td>
      </tr>`;

    if (!_finRel.diasColapsados[dia]) {
      let lastPedido = null;
      let zebraClass = "rel-row-a";
      linhasDia.forEach((l) => {
        if (l.pedidoId !== lastPedido) {
          lastPedido = l.pedidoId;
          zebraClass = zebraClass === "rel-row-a" ? "rel-row-b" : "rel-row-a";
        }
        const bg = zebraClass === "rel-row-a" ? "#fff" : "#f9fafb";
        html += `
          <tr style="background:${bg};">
            <td style="white-space:nowrap; font-size:0.78rem; color:#888;">${l.pedidoLabel}</td>
            <td style="white-space:nowrap; font-size:0.78rem; color:#888;">${l.dataHora}</td>
            <td style="font-size:0.82rem; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${l.cliente}">${l.cliente}</td>
            <td style="font-size:0.85rem; font-weight:500;">${l.nome}</td>
            <td style="text-align:center; font-size:0.85rem;">${l.qtd}</td>
            <td style="text-align:right; white-space:nowrap; font-size:0.85rem;">${l.vlUnit}</td>
            <td style="text-align:right; white-space:nowrap; font-size:0.85rem; font-weight:700; color:#2d6a4f;">${l.subtotal}</td>
            <td style="font-size:0.78rem; color:#555; white-space:nowrap;">${l.pgtoLabel}</td>
          </tr>`;
      });
    }
  });

  tbody.innerHTML = html;
  _finRelAtualizarTotais(linhasFiltradas);
}

/** Expande/recolhe um dia específico no relatório agrupado */
function _finRelToggleDia(dia) {
  _finRel.diasColapsados[dia] = !_finRel.diasColapsados[dia];
  _finRelRenderizar();
}

/** Atualiza os totalizadores do cabeçalho do painel */
function _finRelAtualizarTotais(linhas) {
  const fmt = (n) => "Gs " + Math.round(n).toLocaleString("es-PY");
  const receita = linhas.reduce((s, l) => s + (l._subtotalNum || 0), 0);
  const qtdItens = linhas.reduce((s, l) => s + (typeof l.qtd === "number" ? l.qtd : 0), 0);
  const ticket   = qtdItens > 0 ? receita / qtdItens : 0;

  const el = (id) => document.getElementById(id);
  if (el("fin-rel-tot-itens"))   el("fin-rel-tot-itens").textContent   = qtdItens.toLocaleString("es-PY");
  if (el("fin-rel-tot-receita")) el("fin-rel-tot-receita").textContent = fmt(receita);
  if (el("fin-rel-tot-ticket"))  el("fin-rel-tot-ticket").textContent  = fmt(ticket);
}

/** Navega entre páginas: delta = -1 (anterior) ou +1 (próxima) */
function _finRelPagina(delta) {
  const total    = _finRel.linhasFiltradas.length;
  const maxPag   = Math.max(0, Math.ceil(total / _finRel.PAGE_SIZE) - 1);
  _finRel.pagina = Math.min(maxPag, Math.max(0, _finRel.pagina + delta));
  _finRelRenderizar();
}

/** Expande / colapsa o painel do relatório */
function _finRelToggle(btn) {
  const body = document.getElementById("fin-rel-body");
  if (!body) return;
  _finRel.aberto = !_finRel.aberto;

  if (_finRel.aberto) {
    body.style.display = "block";
    btn.innerHTML = '<i class="fas fa-chevron-up"></i> Recolher';
    btn.style.background = "#495057";
    // Renderiza pela primeira vez ao expandir
    _finRelRenderizar();
  } else {
    body.style.display = "none";
    btn.innerHTML = '<i class="fas fa-chevron-down"></i> Expandir';
    btn.style.background = "#6c757d";
  }
}

/** Exporta as linhas filtradas como CSV UTF-8 com BOM (abre corretamente no Excel) */
function _finRelExportarCSV() {
  const linhas = _finRel.linhasFiltradas;
  if (!linhas.length) { alert("Nenhum dado para exportar."); return; }

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Pedido", "Data/Hora", "Cliente", "Produto", "Qtd", "Vl. Unit. (Gs)", "Subtotal (Gs)", "Pagamento"];

  const rows = linhas.map((l) => [
    l.pedidoLabel, l.dataHora, l.cliente, l.nome, l.qtd,
    Math.round(parseFloat(String(l.vlUnit).replace(/[^\d.]/g, "")) || 0),
    Math.round(l._subtotalNum || 0),
    l.pgtoLabel,
  ].map(escape).join(";"));

  const csv  = "\uFEFF" + [header.map(escape).join(";"), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const hoje = new Date().toISOString().split("T")[0];
  a.href     = url;
  a.download = `relatorio_vendas_${hoje}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Verifica bloqueio por sangria limite ───────────────────────────
async function _verificarBloqueioCaixa(emailAtual) {
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("sangria_limite, caixa_status")
    .maybeSingle();
  if (!cfg?.sangria_limite) return;

  const hoje = new Date();
  const dStr = hoje.toISOString().split("T")[0];
  const { data: movs } = await supa
    .from("movimentacoes_caixa")
    .select("tipo, valor")
    .eq("usuario_email", emailAtual)
    .gte("created_at", dStr + " 00:00:00")
    .lte("created_at", dStr + " 23:59:59");

  let efetivo = 0;
  (movs || []).forEach((m) => {
    const v = parseFloat(m.valor) || 0;
    if (
      m.tipo === "efetivo" ||
      m.tipo === "abertura" ||
      m.tipo === "suprimento"
    )
      efetivo += v;
    if (m.tipo === "sangria") efetivo -= v;
  });

  const status = cfg.caixa_status || {};
  const bloqueado = status[emailAtual]?.bloqueado;
  const banner = document.getElementById("banner-caixa-bloqueado");

  if (!bloqueado && efetivo >= cfg.sangria_limite) {
    // Bloqueia
    const novoStatus = {
      ...status,
      [emailAtual]: {
        bloqueado: true,
        bloqueado_em: new Date().toISOString(),
        autorizado_por: null,
      },
    };
    await supa
      .from("configuracoes")
      .update({ caixa_status: novoStatus })
      .gt("id", 0);
    if (banner) {
      banner.style.display = "block";
      banner.querySelector("#banner-sangria-msg").textContent =
        `Caixa bloqueado: efetivo atingiu o limite de sangria (Gs ${cfg.sangria_limite.toLocaleString("es-PY")}). Solicite autorização de um gestor.`;
    }
    return;
  }
  if (banner) banner.style.display = bloqueado ? "block" : "none";
}

async function autorizarReaberturaCaixa(emailAlvo) {
  if (!["dono", "gerente", "adminMaster"].includes(perfilUsuario)) {
    alert(t("alert.acesso_negado"));
    return;
  }
  if (!confirm(`Autorizar reabertura do caixa de ${emailAlvo}?`)) return;
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("caixa_status")
    .maybeSingle();
  const status = { ...(cfg?.caixa_status || {}) };
  const emailGestor = document.getElementById("user-email")?.innerText || "";
  status[emailAlvo] = {
    bloqueado: false,
    autorizado_por: emailGestor,
    autorizado_em: new Date().toISOString(),
  };
  await supa.from("configuracoes").update({ caixa_status: status }).gt("id", 0);
  alert(t("alert.caixa_reaberto"));
  calcularFinanceiro();
}

async function exportarFinanceiro() {
  // 1. Pega os mesmos filtros da tela
  const elInicio = document.getElementById("fin-inicio");
  const elFim = document.getElementById("fin-fim");
  const elTipo = document.getElementById("fin-tipo");
  const elFactura = document.getElementById("fin-factura");

  const inicio = elInicio.value;
  const fim = elFim.value;
  const tipoFiltro = elTipo ? elTipo.value : "todos";
  const facturaFiltro = elFactura ? elFactura.value : "todos";

  // Define período
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = String(hoje.getMonth() + 1).padStart(2, "0");
  const dia = String(hoje.getDate()).padStart(2, "0");

  // Define período — corrige fuso: Assunção é UTC-3 permanente desde 2024
  // O Supabase armazena UTC, então desloca o intervalo local para UTC via helper
  const _refDate = new Date(); // data de referência para calcular o offset atual
  const _TZ_OFFSET_MS = _getAsuncionOffsetMs(_refDate); // UTC-3 = 3h em ms
  let dataInicio, dataFim;
  if (inicio && fim) {
    dataInicio = new Date(
      new Date(inicio + "T00:00:00").getTime() + _TZ_OFFSET_MS,
    ).toISOString();
    dataFim = new Date(
      new Date(fim + "T23:59:59").getTime() + _TZ_OFFSET_MS,
    ).toISOString();
  } else {
    dataInicio = new Date(
      new Date(`${ano}-${mes}-${dia}T00:00:00`).getTime() + _TZ_OFFSET_MS,
    ).toISOString();
    dataFim = new Date(
      new Date(`${ano}-${mes}-${dia}T23:59:59`).getTime() + _TZ_OFFSET_MS,
    ).toISOString();
  }

  // 2. Busca os dados
  let query = supa
    .from("pedidos")
    .select("*")
    .neq("status", "cancelado")
    .gte("created_at", dataInicio)
    .lte("created_at", dataFim);

  if (tipoFiltro !== "todos") {
    query = query.eq("forma_pagamento", tipoFiltro);
  }

  const { data: pedidos, error } = await query;

  if (error) {
    alert("Erro ao buscar dados: " + error.message);
    return;
  }

  if (!pedidos || pedidos.length === 0) {
    alert("Nenhum pedido encontrado no período selecionado.");
    return;
  }

  // 3. Filtra por factura se necessário
  let pedidosFiltrados = pedidos;
  if (facturaFiltro === "com_factura") {
    pedidosFiltrados = pedidos.filter(
      (p) => p.dados_factura && (p.dados_factura.ruc || p.dados_factura.ci),
    );
  } else if (facturaFiltro === "sem_factura") {
    pedidosFiltrados = pedidos.filter(
      (p) => !p.dados_factura || (!p.dados_factura.ruc && !p.dados_factura.ci),
    );
  }

  // 4. Prepara dados para CSV
  let csv =
    "ID Pedido,Data/Hora,Cliente,Telefone,Tipo Entrega,Forma Pagamento,Subtotal,Frete,Total,RUC/CI,Razão Social\n";

  pedidosFiltrados.forEach((p) => {
    const data = new Date(p.created_at).toLocaleString("pt-BR");
    const cliente = (p.cliente_nome || "").replace(/,/g, " "); // Remove vírgulas
    const telefone = p.cliente_telefone || "";
    const tipo = p.tipo_entrega || "";
    const pagamento = p.forma_pagamento || "";
    const subtotal = p.subtotal || 0;
    const frete = p.frete_cobrado_cliente || 0;
    const total = p.total_geral || 0;
    const ruc = p.dados_factura?.ruc || p.dados_factura?.ci || "";
    const razao = (p.dados_factura?.razao || "").replace(/,/g, " ");

    csv += `${p.id},${data},${cliente},${telefone},${tipo},${pagamento},${subtotal},${frete},${total},${ruc},${razao}\n`;
  });

  // 5. Cria arquivo e faz download
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute(
    "download",
    `Relatorio_Financeiro_${ano}-${mes}-${dia}.csv`,
  );
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  alert(
    `✅ Relatório exportado com sucesso!\n\nTotal de pedidos: ${pedidosFiltrados.length}`,
  );
}

// =====================================================
// ALTERNATIVA: EXPORTAR PARA EXCEL REAL (XLSX)
// =====================================================
// Se quiser usar biblioteca SheetJS para Excel verdadeiro:

async function exportarFinanceiroXLSX() {
  // Aviso: Requer biblioteca SheetJS
  if (typeof XLSX === "undefined") {
    alert("Biblioteca XLSX não carregada. Usando CSV simples.");
    exportarFinanceiro();
    return;
  }

  // Busca os dados (mesmo código acima)
  // ... código de busca ...

  // Cria planilha
  const ws = XLSX.utils.json_to_sheet(
    pedidosFiltrados.map((p) => ({
      ID: p.id,
      Data: new Date(p.created_at).toLocaleString("pt-BR"),
      Cliente: p.cliente_nome,
      Telefone: p.cliente_telefone,
      Tipo: p.tipo_entrega,
      Pagamento: p.forma_pagamento,
      Subtotal: p.subtotal,
      Frete: p.frete_cobrado_cliente,
      Total: p.total_geral,
      "RUC/CI": p.dados_factura?.ruc || p.dados_factura?.ci || "",
      Razão: p.dados_factura?.razao || "",
    })),
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Vendas");

  const hoje = new Date();
  XLSX.writeFile(
    wb,
    `Relatorio_${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}.xlsx`,
  );
}

// =====================================================
// RELATÓRIO DETALHADO DE PEDIDOS
// =====================================================
async function abrirRelatorio() {
  const modal = document.getElementById("modal-relatorio");
  if (modal) {
    modal.style.display = "flex";
    await carregarRelatorio();
  }
}

async function carregarRelatorio() {
  const filtroNum = document.getElementById("rel-filtro-numero")?.value?.trim();
  const filtroInicio = document.getElementById("rel-filtro-inicio")?.value;
  const filtroFim = document.getElementById("rel-filtro-fim")?.value;
  // Hora do servidor (não o relógio do dispositivo) para o padrão "hoje"
  const _horaServRel = await _obterHoraServidor();
  const hoje = _horaServRel.date_py;
  // ⚠️ CORREÇÃO: antes havia um .limit(100) fixo aplicado mesmo quando o
  // filtro de datas cobria um período maior — cortava silenciosamente os
  // pedidos mais antigos da lista (ordenado por id decrescente), dando a
  // falsa impressão de que "sumiram". Mantemos um teto alto (2000) só
  // como proteção contra períodos enormes, não como limite de uso normal.
  let query = supa
    .from("pedidos")
    .select("*")
    .order("id", { ascending: false })
    .limit(2000);
  if (filtroNum) {
    query = query.eq("id", parseInt(filtroNum));
  } else {
    const ini = filtroInicio || hoje;
    const fim = filtroFim || hoje;
    // Assunção UTC-3 permanente desde 2024: desloca datas locais para UTC
    const _off = _getAsuncionOffsetMs(new Date(ini + "T00:00:00"));
    const utcIni = new Date(
      new Date(ini + "T00:00:00").getTime() + _off,
    ).toISOString();
    const utcFim = new Date(
      new Date(fim + "T23:59:59").getTime() + _off,
    ).toISOString();
    query = query.gte("created_at", utcIni).lte("created_at", utcFim);
  }
  const { data: pedidos, error } = await query;
  if (error) {
    console.error(error);
    return;
  }
  const tbody = document.getElementById("rel-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const fmtDiff = (t1, t2) => {
    if (!t1 || !t2) return "-";
    const diff = Math.round((new Date(t2) - new Date(t1)) / 60000);
    if (diff < 60) return diff + " min";
    return Math.floor(diff / 60) + "h " + (diff % 60) + "m";
  };
  const fmtHora = (t) =>
    t
      ? new Date(t).toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Asuncion",
        })
      : "-";
  const scMap = {
    pendente: { bg: "#fff3cd", color: "#856404", label: "⏳ Pendente" },
    em_preparo: { bg: "#ffe5d0", color: "#a63c06", label: "🔥 Em Preparo" },
    pronto_entrega: { bg: "#d1ecf1", color: "#0c5460", label: "📦 Pronto" },
    saiu_entrega: { bg: "#d4edda", color: "#155724", label: "🛵 Saiu" },
    entregue: { bg: "#d4edda", color: "#155724", label: "✅ Entregue" },
    cancelado: { bg: "#f8d7da", color: "#721c24", label: "❌ Cancelado" },
  };

  (pedidos || []).forEach((p) => {
    const sc = scMap[p.status] || {
      bg: "#f0f0f0",
      color: "#333",
      label: p.status,
    };
    const isPDV = p.tipo_entrega === "balcao";

    const itensList = (p.itens || [])
  .map((i) => {
    const qtd = i.qtd || i.q || 1;
    const nome = i.nome || i.n || "?";
    const variacao = i.variacao || i.t || "";
    const montagem = i.montagem || i.m || [];
    let lbl = `<strong>${qtd}x</strong> ${nome}`;
    // EXIBE A VARIAÇÃO COM DESTAQUE
    if (variacao && variacao !== nome) {
      lbl += ` <span style="color:#e67e22; font-weight:700;">[${variacao}]</span>`;
    } else if (variacao) {
      lbl += ` <span style="color:#888; font-size:0.8em;">(${variacao})</span>`;
    }
    // ... resto do código (montagem, etc.)
    return lbl;
  })
  .join("<br>");

    // Cancelamento info
    let cancelInfo = "";
    if (p.status === "cancelado") {
      const quem = p.cancelamento_solicitado_por || "admin";
      cancelInfo = `<div style="margin-top:5px;padding:5px 7px;background:#fde;border-radius:6px;font-size:0.72rem;color:#a00">
        🚫 <strong>Por:</strong> ${quem}${p.cancelamento_motivo ? "<br><em>" + p.cancelamento_motivo + "</em>" : ""}</div>`;
    } else if (p.cancelamento_solicitado) {
      cancelInfo = `<div style="margin-top:4px;font-size:0.7rem;color:#e74c3c">
        🚫 Solicitado por: ${p.cancelamento_solicitado_por || "?"}</div>`;
    }

    // Tipo badge
    const tipoBadges = {
      balcao:
        '<span style="background:#e8f4f8;color:#1a6e8a;border-radius:10px;padding:2px 7px;font-size:0.68rem;font-weight:700">🏪 PDV</span>',
      delivery:
        '<span style="background:#e8f7e8;color:#1a6e2e;border-radius:10px;padding:2px 7px;font-size:0.68rem;font-weight:700">🛵 Delivery</span>',
      retirada:
        '<span style="background:#f7f0e8;color:#6e4a1a;border-radius:10px;padding:2px 7px;font-size:0.68rem;font-weight:700">🚶 Retirada</span>',
    };
    const tipoBadge = tipoBadges[p.tipo_entrega] || "";
    const _podeCancelRel = ["dono", "adminMaster", "gerente", "funcionario"].includes(perfilUsuario);
    const jaCancelado = p.status === "cancelado";

    // Timeline — PDV tem etapas diferentes
    const tl = isPDV
      ? [
          {
            icon: "🏪",
            label: "Abertura",
            val: fmtHora(p.tempo_recebido || p.created_at),
            diff: null,
          },
          {
            icon: "🔥",
            label: "Separação",
            val: fmtHora(p.tempo_preparo_iniciado),
            diff: null,
          },
          {
            icon: "📦",
            label: "Pronto",
            val: fmtHora(p.tempo_pronto),
            diff: fmtDiff(p.tempo_preparo_iniciado, p.tempo_pronto),
          },
          {
            icon: "✅",
            label: "Fechado",
            val: fmtHora(p.tempo_entregue),
            diff: fmtDiff(p.tempo_recebido || p.created_at, p.tempo_entregue),
          },
        ]
      : [
          {
            icon: "📥",
            label: "Recebido",
            val: fmtHora(p.tempo_recebido),
            diff: null,
          },
          {
            icon: "✅",
            label: "Aceite",
            val: fmtHora(p.tempo_confirmado),
            diff: fmtDiff(p.tempo_recebido, p.tempo_confirmado),
          },
          {
            icon: "🔥",
            label: "Separação",
            val: fmtHora(p.tempo_preparo_iniciado),
            diff: null,
          },
          {
            icon: "📦",
            label: "Pronto",
            val: fmtHora(p.tempo_pronto),
            diff: fmtDiff(p.tempo_preparo_iniciado, p.tempo_pronto),
          },
          {
            icon: "🛵",
            label: "Saiu",
            val: fmtHora(p.tempo_saiu_entrega),
            diff: null,
          },
          {
            icon: "🏠",
            label: "Entregue",
            val: fmtHora(p.tempo_entregue),
            diff: fmtDiff(p.tempo_saiu_entrega, p.tempo_entregue),
          },
        ];

    const tlHtml = tl
      .map((t) => {
        const vazio = t.val === "-";
        return `<div style="display:flex;align-items:baseline;gap:5px;padding:2px 0;border-bottom:1px solid #f5f5f5">
        <span style="min-width:18px;font-size:0.85em">${t.icon}</span>
        <span style="min-width:64px;font-size:0.72rem;color:#888">${t.label}:</span>
        <span style="font-size:0.78rem;font-weight:${vazio ? "400" : "600"};color:${vazio ? "#ccc" : "#222"}">${t.val}</span>
        ${t.diff && t.diff !== "-" ? `<span style="font-size:0.68rem;color:#999">(${t.diff})</span>` : ""}
      </div>`;
      })
      .join("");

    const totalTime = isPDV
      ? fmtDiff(p.tempo_recebido || p.created_at, p.tempo_entregue)
      : fmtDiff(p.tempo_recebido, p.tempo_entregue);

    const _tz = { timeZone: "America/Asuncion" };
    tbody.innerHTML += `<tr style="border-bottom:1px solid #eee;vertical-align:top">
      <td style="padding:10px 8px;white-space:nowrap">
        <div style="font-size:1rem;font-weight:700;color:#1a1a2e">#${p.id}</div>
        <div style="font-size:0.73rem;color:#aaa">${new Date(p.created_at).toLocaleDateString("pt-BR", _tz)}</div>
        <div style="font-size:0.78rem;color:#666">${new Date(p.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ..._tz })}</div>
      </td>
      <td style="padding:10px 8px">
        <div style="font-weight:700;color:#1a1a2e">${p.cliente_nome || "-"}</div>
        <div style="font-size:0.73rem;color:#999">📞 ${p.cliente_telefone || "-"}</div>
        <div style="margin-top:4px">${tipoBadge}</div>
      </td>
      <td style="padding:10px 8px;font-size:0.82rem;max-width:260px;line-height:1.6">${itensList || "-"}</td>
      <td style="padding:10px 8px;white-space:nowrap">
        <span style="display:inline-block;padding:4px 10px;border-radius:20px;font-size:0.73rem;font-weight:700;background:${sc.bg};color:${sc.color}">${sc.label}</span>
        ${cancelInfo}
      </td>
      <td style="padding:10px 8px;white-space:nowrap;text-align:right">
        <div style="font-size:0.95rem;font-weight:700;color:#1a1a2e">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</div>
        <div style="font-size:0.7rem;color:#aaa;margin-top:2px">${p.forma_pagamento || ""}</div>
      </td>
      <td style="padding:10px 8px;min-width:175px">
        ${tlHtml}
        ${totalTime !== "-" ? `<div style="margin-top:5px;padding:3px 7px;background:#f0f4ff;border-radius:6px;font-size:0.75rem;font-weight:700;color:#3a4db7;text-align:center">⏱ ${totalTime}</div>` : ""}
      </td>
      <td style="padding:10px 8px;white-space:nowrap;text-align:center;min-width:90px">
        ${(!jaCancelado && _podeCancelRel) ? `<button class="btn btn-danger btn-sm" onclick="cancelarPedidoRelatorio(${p.id})" title="Cancelar este pedido" style="font-size:0.7rem;padding:4px 8px">
          <i class="fas fa-times"></i> Cancelar
        </button>` : (jaCancelado ? '<span style="color:#aaa;font-size:0.7rem">Cancelado</span>' : '')}
      </td>
    </tr>`;
  });
  if (!pedidos || pedidos.length === 0)
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;padding:40px;color:#aaa">Nenhum pedido encontrado.</td></tr>';
  const el = document.getElementById("rel-total-count");
  if (el) el.textContent = (pedidos || []).length + " pedidos encontrados";
}

async function cancelarPedidoRelatorio(pedidoId) {
  if (!confirm("⚠️ Tem certeza que deseja CANCELAR este pedido?\n\nEsta ação não pode ser desfeita e irá repor o estoque (se já tiver sido baixado).")) {
    return;
  }
  // Chama a função existente, que já faz todo o tratamento
  await mudarStatus(pedidoId, 'cancelado');
  // Recarrega o relatório para atualizar a lista
  carregarRelatorio();
}

function abrirModalCaixa(tipo) {
  document.getElementById("modal-caixa").style.display = "flex";
  document.getElementById("tipo-caixa").value = tipo;

  const titulos = {
    abertura: "🟢 Abrir Caixa",
    suprimento: "➕ Suprimento",
    sangria: "💸 Sangria",
    despesa: "🧾 Despesa",
  };
  document.getElementById("titulo-caixa").innerText =
    titulos[tipo] || "Operação";
  document.getElementById("valor-caixa").value = "";
  document.getElementById("desc-caixa").value = "";

  // Mostra/oculta seletor de tipo de despesa
  const despesaBox = document.getElementById("box-tipo-despesa");
  if (despesaBox)
    despesaBox.style.display = tipo === "despesa" ? "block" : "none";
  document.getElementById("valor-caixa").focus();
}

async function salvarMovimentacaoCaixa() {
  const tipo = document.getElementById("tipo-caixa").value;
  const valor = parseFloat(document.getElementById("valor-caixa").value);
  const desc = document.getElementById("desc-caixa").value.trim();

  if (!valor || valor <= 0) {
    alert("Digite um valor válido.");
    return;
  }

  const emailAtual = document.getElementById("user-email")?.innerText || "";

  // Bloquear se caixa bloqueado
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("caixa_status")
    .maybeSingle();
  const status = cfg?.caixa_status || {};
  if (status[emailAtual]?.bloqueado && tipo !== "sangria") {
    alert(
      "⛔ Caixa bloqueado por sangria. Solicite autorização de um gestor para reabrir.",
    );
    return;
  }

  let tipoDespesa = null,
    descOutro = null;
  if (tipo === "despesa") {
    tipoDespesa =
      document.getElementById("tipo-despesa-sel")?.value || "despesas_gerais";
    if (tipoDespesa === "outro") {
      descOutro =
        document.getElementById("desc-outro-despesa")?.value?.trim() || "";
      if (!descOutro) {
        alert("Descreva o tipo da despesa.");
        return;
      }
    }
  }

  // ── Se for ABERTURA, cria a sessão primeiro ───────────────────────
  if (tipo === "abertura") {
    try {
      await _abrirSessaoCaixa(valor, desc);
      alert(
        `✅ Caixa aberto com fundo de Gs ${valor.toLocaleString("es-PY")}!`,
      );
      fecharModal("modal-caixa");
      _pdvAtualizarPainelCaixa(); // sincroniza painel no PDV
      calcularFinanceiro();
      return;
    } catch (e) {
      alert("Erro ao abrir caixa: " + e.message);
      return;
    }
  }

  // ── Para outros tipos, verifica se há sessão aberta ───────────────
  if (!_sessaoCaixaAtiva) {
    alert(
      "⚠️ Nenhum caixa aberto. Abra o caixa antes de registrar movimentações.",
    );
    return;
  }

  const insert = {
    tipo,
    valor,
    descricao: desc,
    usuario_email: emailAtual,
    tipo_despesa: tipoDespesa,
    descricao_outro: descOutro,
    sessao_id: _sessaoCaixaAtiva.id, // ← vínculo com a sessão
  };

  const { error } = await supa.from("movimentacoes_caixa").insert([insert]);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }

  alert(t("alert.operacao_registrada"));
  fecharModal("modal-caixa");
  calcularFinanceiro();
}

async function fecharCaixaResumo() {
  if (!_sessaoCaixaAtiva) {
    alert("Nenhum caixa aberto para fechar.");
    return;
  }

  if (
    !confirm(
      "Fechar o caixa desta sessão?\nIsso encerra a sessão e registra o fechamento.",
    )
  )
    return;

  // ⚠️ CORREÇÃO: o fechamento NUNCA pode depender do filtro de datas que
  // porventura esteja selecionado na tela (ex: gestor navegando um dia
  // antigo pelo filtro manual). Isso fazia o boletim de fechamento sair
  // com os números do dia FILTRADO em vez da sessão real sendo fechada
  // — o que na prática aparecia como "zerado" sempre que o filtro
  // apontava pra um período sem sobreposição com a sessão atual.
  // Por isso, limpamos o filtro temporariamente para forçar o cálculo
  // pela janela real da sessão (aberto_em → agora), e restauramos o
  // filtro original da tela depois, sem afetar o que o usuário via.
  const elIniTmp = document.getElementById("fin-inicio");
  const elFimTmp = document.getElementById("fin-fim");
  const _filtroOriginalIni = elIniTmp?.value || "";
  const _filtroOriginalFim = elFimTmp?.value || "";
  if (elIniTmp) elIniTmp.value = "";
  if (elFimTmp) elFimTmp.value = "";

  await calcularFinanceiro(); // garante que _caixaState está atualizado (janela = sessão real)
  const s = _caixaState;
  const fmt = (n) => "Gs " + n.toLocaleString("es-PY");
  const lucro =
    s.faturamento + s.totalEntradas - s.custoEntregas - s.totalSaidas;

  // Hora do servidor — mesma razão do _abrirSessaoCaixa(): não confiar
  // no relógio do dispositivo para o timestamp oficial de fechamento.
  const horaServ = await _obterHoraServidor();
  const dataFechamentoBr = new Date(
    horaServ.date_py + "T" + horaServ.time_py,
  ).toLocaleDateString("pt-BR");

  // ── Monta o boletim estruturado e PERSISTE no banco ────────────────
  // Isso é o que faltava: antes só existia um alert() na hora, que se
  // perdia assim que fechado — por isso "o relatório de fechamento vem
  // zerado" quando alguém tenta consultar depois. Agora fica salvo em
  // sessoes_caixa.resumo_fechamento e pode ser reaberto a qualquer
  // momento via abrirRelatorioFechamento(), sem depender de recálculo.
  const resumoFechamento = {
    abertura_em: _sessaoCaixaAtiva.aberto_em,
    fechamento_em: horaServ.iso,
    valor_abertura: _sessaoCaixaAtiva.valor_abertura || 0,
    faturamento: s.faturamento,
    lucro_bruto_vendas: s.lucroBrutoVendas || 0,
    resultado_operacional: lucro,
    por_forma_pagamento: {
      efetivo: s.totalEfetivo,
      pix: s.totalPix,
      cartao: s.totalCartao,
      cartao_br: s.totalCartaoBR,
      transferencia: s.totalTransf,
      qr_paraguay: s.totalQrPy,
      multi_outros: s.totalMultiOutros,
    },
    na_nota_aberto: s.totalNaNotaAberto || 0,
    qtd_pedidos: s.qtdPedidos,
    custo_entregas: s.custoEntregas,
    total_saidas: s.totalSaidas,
    total_entradas: s.totalEntradas,
    dinheiro_na_gaveta:
      (_sessaoCaixaAtiva.valor_abertura || 0) + s.totalEfetivo - s.totalSaidas,
  };

  try {
    // 1. Marca a sessão como fechada e salva o boletim estruturado
    await supa
      .from("sessoes_caixa")
      .update({
        fechado_em: horaServ.iso,
        valor_fechamento: lucro,
        observacao: `Fat: ${fmt(s.faturamento)} | Res: ${fmt(lucro)}`,
        resumo_fechamento: resumoFechamento,
      })
      .eq("id", _sessaoCaixaAtiva.id);

    // 2. Registra movimentação de fechamento vinculada à sessão
    await supa.from("movimentacoes_caixa").insert([
      {
        tipo: "fechamento",
        valor: lucro,
        descricao: `Fechamento ${dataFechamentoBr} | Fat: ${fmt(s.faturamento)} | Res: ${fmt(lucro)}`,
        usuario_email:
          document.getElementById("user-email")?.innerText || "admin",
        sessao_id: _sessaoCaixaAtiva.id,
      },
    ]);
  } catch (e) {
    console.warn("Aviso fechamento:", e.message);
  }

  const sessaoIdFechada = _sessaoCaixaAtiva.id;

  // Limpa a sessão ativa em memória e atualiza o indicador global
  _sessaoCaixaAtiva = null;
  const elStatusGlobal = document.getElementById("status-sessao-caixa");
  if (elStatusGlobal)
    elStatusGlobal.innerHTML = `<span style="color:#e74c3c">🔴 Nenhum caixa aberto</span>`;
  _pdvAtualizarPainelCaixa();

  // Restaura o filtro de datas original da tela (o que o gestor estava
  // navegando antes de fechar o caixa) — só usamos a janela em branco
  // (= sessão real) para o CÁLCULO do boletim, não para a visão da tela.
  if (elIniTmp) elIniTmp.value = _filtroOriginalIni;
  if (elFimTmp) elFimTmp.value = _filtroOriginalFim;

  // Recalcula o dashboard com o filtro restaurado (ou o padrão "sem
  // sessão" — últimos 7 dias — se não havia filtro manual antes).
  await calcularFinanceiro();

  // Mostra o boletim de fechamento — o mesmo que fica salvo e pode ser
  // reaberto depois em "Histórico de Caixa" (abrirRelatorioFechamento).
  abrirRelatorioFechamento(sessaoIdFechada);
}

/* ══════════════════════════════════════════════════════════════
   RELATÓRIO DE FECHAMENTO — visualização persistida
   Lê sessoes_caixa.resumo_fechamento (gravado em fecharCaixaResumo)
   em vez de recalcular ao vivo, então nunca aparece "zerado" mesmo
   consultando dias depois. Também lista as movimentações do caixa
   daquela sessão (sangrias, suprimentos, quitações de Na Nota etc).
   ══════════════════════════════════════════════════════════════ */
async function abrirRelatorioFechamento(sessaoId) {
  const { data: sessao, error } = await supa
    .from("sessoes_caixa")
    .select("*")
    .eq("id", sessaoId)
    .single();

  if (error || !sessao) {
    alert("Não foi possível carregar o relatório de fechamento: " + (error?.message || "sessão não encontrada"));
    return;
  }

  const r = sessao.resumo_fechamento;
  const fmt = (n) => "Gs " + Math.round(n || 0).toLocaleString("es-PY");
  const dataHora = (iso) =>
    iso ? new Date(iso).toLocaleString("es-PY", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

  const { data: movs } = await supa
    .from("movimentacoes_caixa")
    .select("*")
    .eq("sessao_id", sessaoId)
    .order("created_at", { ascending: true });

  document.getElementById("modal-relatorio-fechamento")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "modal-relatorio-fechamento";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:16px;padding:0;max-width:480px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)";

  const semResumo = !r; // sessões fechadas antes desta correção não têm o campo

  modal.innerHTML = `
    <div style="padding:20px 22px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#fff;border-radius:16px 16px 0 0;">
      <h3 style="margin:0;font-size:1.1rem;">📋 Relatório de Fechamento</h3>
      <button onclick="document.getElementById('modal-relatorio-fechamento').remove()"
        style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>
    </div>
    <div style="padding:20px 22px;">
      ${semResumo ? `
        <div style="background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;padding:10px 12px;font-size:0.82rem;color:#664d03;margin-bottom:16px">
          ⚠️ Esta sessão foi fechada antes da correção do boletim estruturado, então não há dados detalhados salvos — só o resumo abaixo.
        </div>` : ""}
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px;">
        <span style="color:#888">Abertura</span>
        <strong>${dataHora(sessao.aberto_em)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:16px;">
        <span style="color:#888">Fechamento</span>
        <strong>${dataHora(sessao.fechado_em)}</strong>
      </div>

      ${r ? `
      <div style="background:#f8fafc;border-radius:10px;padding:14px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px;">
          <span>💰 Faturamento</span><strong>${fmt(r.faturamento)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px;">
          <span>🏍️ Custo Entregas</span><strong>${fmt(r.custo_entregas)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px;">
          <span>💸 Saídas</span><strong>${fmt(r.total_saidas)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px;">
          <span>➕ Entradas</span><strong>${fmt(r.total_entradas)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.95rem;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;">
          <span style="font-weight:700">Resultado Operacional</span>
          <strong style="color:#16a34a">${fmt(r.resultado_operacional)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.95rem;margin-top:6px;">
          <span style="font-weight:700">💰 Dinheiro na Gaveta</span>
          <strong>${fmt(r.dinheiro_na_gaveta)}</strong>
        </div>
      </div>

      <div style="font-weight:700;font-size:0.85rem;margin-bottom:8px;">💳 Por Forma de Pagamento</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
        ${[
          ["💵 Efetivo", r.por_forma_pagamento?.efetivo],
          ["💳 Cartão PY", r.por_forma_pagamento?.cartao],
          ["📱 Pix", r.por_forma_pagamento?.pix],
          ["🏦 Transferência", r.por_forma_pagamento?.transferencia],
          ["📲 QR Paraguay", r.por_forma_pagamento?.qr_paraguay],
          ["💳🇧🇷 Cartão BR", r.por_forma_pagamento?.cartao_br],
          ["🔀 Multi/Outros", r.por_forma_pagamento?.multi_outros],
        ].map(([label, val]) => `
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;background:#f9fafb;border-radius:6px;padding:8px 10px">
            <span>${label}</span><strong>${fmt(val)}</strong>
          </div>`).join("")}
        ${r.na_nota_aberto > 0 ? `
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;background:#fef2f2;border-radius:6px;padding:8px 10px;color:#991b1b">
            <span>📋 Em Aberto (Na Nota)</span><strong>${fmt(r.na_nota_aberto)}</strong>
          </div>` : ""}
      </div>
      ` : ""}

      <div style="font-weight:700;font-size:0.85rem;margin-bottom:8px;">📑 Movimentações do Caixa</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${(movs && movs.length) ? movs.map((m) => `
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:8px 10px;border:1px solid #eee;border-radius:6px">
            <span style="color:#555">${m.descricao || m.tipo}</span>
            <strong style="color:${m.tipo === 'saida' || m.tipo === 'sangria' ? '#dc2626' : '#16a34a'}">${fmt(m.valor)}</strong>
          </div>`).join("") : `<div style="color:#aaa;font-size:0.82rem;text-align:center;padding:12px">Nenhuma movimentação registrada.</div>`}
      </div>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// =========================================
// EXPORTAÇÕES: CSV (Power BI) e PDF
// =========================================

async function _buscarDadosRelatorio() {
  // Usa exatamente a mesma janela de tempo que a tela do Financeiro
  // (sessão de caixa / filtro manual / hoje via hora do servidor),
  // para que o CSV/PDF exportado NUNCA divirja do que está na tela.
  const { utcI, utcF } = await _janelaFinanceiroAtual();
  const { data } = await supa
    .from("pedidos")
    .select("*")
    .in("status", ["entregue", "em_preparo", "pronto_entrega", "saiu_entrega"])
    .gte("created_at", utcI)
    .lte("created_at", utcF);
  return data || [];
}

// ── CSV rico para Power BI ────────────────────────────────
async function exportarCSVPowerBI() {
  const pedidos = await _buscarDadosRelatorio();
  if (!pedidos.length) {
    alert("Nenhum pedido no período.");
    return;
  }

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const cols = [
    "id",
    "uid_temporal",
    "status",
    "tipo_entrega",
    "created_at",
    "cliente_nome",
    "cliente_telefone",
    "endereco_entrega",
    "forma_pagamento",
    "obs_pagamento",
    "subtotal",
    "desconto_cupom",
    "frete_cobrado_cliente",
    "total_geral",
    "cupom_codigo",
    "frete_motoboy",
    "garcom_nome",
    "tempo_recebido",
    "tempo_confirmado",
    "tempo_preparo_iniciado",
    "tempo_pronto",
    "tempo_saiu_entrega",
    "tempo_entregue",
    "itens_qtd",
    "itens_nomes",
    "ruc_factura",
    "razao_factura",
  ];

  const rows = pedidos.map((p) => {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const itensQtd = itens.reduce((a, i) => a + (i.qtd || i.q || 1), 0);
    const itensNomes = itens
      .map((i) => `${i.qtd || i.q || 1}x ${i.nome || i.n}`)
      .join(" | ");
    const f = p.dados_factura || {};
    return [
      p.id,
      p.uid_temporal || "",
      p.status,
      p.tipo_entrega,
      p.created_at ? new Date(p.created_at).toLocaleString("pt-BR") : "",
      p.cliente_nome || "",
      p.cliente_telefone || "",
      p.endereco_entrega || "",
      p.forma_pagamento || "",
      p.obs_pagamento || "",
      p.subtotal || 0,
      p.desconto_cupom || 0,
      p.frete_cobrado_cliente || 0,
      p.total_geral || 0,
      p.cupom_codigo || "",
      p.frete_motoboy || 0,
      p.garcom_nome || "",
      p.tempo_recebido || "",
      p.tempo_confirmado || "",
      p.tempo_preparo_iniciado || "",
      p.tempo_pronto || "",
      p.tempo_saiu_entrega || "",
      p.tempo_entregue || "",
      itensQtd,
      itensNomes,
      f.ruc || f.ci || "",
      f.razao || "",
    ]
      .map(escape)
      .join(",");
  });

  const csv = "\uFEFF" + cols.join(",") + "\n" + rows.join("\n"); // BOM para Excel/PBI
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const hoje = new Date().toISOString().split("T")[0];
  a.href = url;
  a.download = `relatorio_${hoje}_powerbi.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  alert(t("alert.csv_exportado") + ` (${pedidos.length} pedidos)`);
}

// ── PDF via janela de impressão ───────────────────────────
async function exportarPDF() {
  const pedidos = await _buscarDadosRelatorio();
  if (!pedidos.length) {
    alert("Nenhum pedido no período.");
    return;
  }

  const elI = document.getElementById("fin-inicio");
  const elF = document.getElementById("fin-fim");
  const hoje = new Date().toISOString().split("T")[0];
  const periodoLabel = `${elI?.value || hoje} a ${elF?.value || hoje}`;

  const fmt = (n) => "Gs " + (n || 0).toLocaleString("es-PY");
  const total = pedidos.reduce((a, p) => a + (p.total_geral || 0), 0);

  // Reutiliza a mesma lógica de classificação do calcularFinanceiro
  let totalPix = 0, totalEfet = 0, totalCard = 0, totalTransf = 0,
      totalQrPy = 0, totalCartaoBR = 0, totalMulti = 0;
  pedidos.forEach((p) => {
    const pag = (p.forma_pagamento || "").toLowerCase();
    const obsPag = p.obs_pagamento || "";
    const val = p.total_geral || 0;
    if (pag === "multipagamento" && obsPag) {
      try {
        const partes = JSON.parse(obsPag);
        if (Array.isArray(partes)) {
          partes.forEach((parte) => {
            const pf = (parte.metodo || parte.forma || "").toLowerCase();
            const pv = Number(parte.valor) || 0;
            if (pf.includes("pix"))                                   totalPix     += pv;
            else if (pf.includes("transfer"))                         totalTransf  += pv;
            else if (pf.includes("qrpy") || pf.includes("qr"))       totalQrPy    += pv;
            else if (pf.includes("cartaobr") || pf.includes("br"))   totalCartaoBR+= pv;
            else if (pf.includes("cartao") || pf.includes("cartão")) totalCard    += pv;
            else                                                       totalEfet   += pv;
          });
        } else { totalMulti += val; }
      } catch (_) { totalMulti += val; }
    } else if (pag.includes("pix"))                                   totalPix     += val;
    else if (pag.includes("transfer") || pag.includes("alias"))      totalTransf  += val;
    else if (pag === "qrpy")                                          totalQrPy    += val;
    else if (pag === "cartaobr")                                      totalCartaoBR+= val;
    else if (pag.includes("cart"))                                    totalCard    += val;
    else if (pag.includes("efetivo") || pag.includes("dinheiro"))    totalEfet    += val;
    else                                                              totalMulti   += val;
  });

  const rows = pedidos
    .map((p) => {
      const tz = { timeZone: "America/Asuncion" };
      const hora = new Date(p.created_at).toLocaleString("pt-BR", tz);
      const itens = (Array.isArray(p.itens) ? p.itens : [])
        .map((i) => `${i.qtd || i.q || 1}x ${i.nome || i.n}`)
        .join(", ");
      return `<tr>
      <td>${p.uid_temporal || "#" + p.id}</td>
      <td>${hora}</td>
      <td>${p.cliente_nome || "-"}</td>
      <td>${itens || "-"}</td>
      <td>${p.forma_pagamento || "-"}</td>
      <td style="text-align:right">${fmt(p.total_geral)}</td>
    </tr>`;
    })
    .join("");

  const nomeRestaurante = NOME_RESTAURANTE || "Relatório";

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Relatório ${periodoLabel}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:20px}
    h1{font-size:16px;margin-bottom:2px}
    .sub{font-size:11px;color:#666;margin-bottom:16px}
    .resumo{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}
    .card{background:#f5f5f5;border-radius:6px;padding:10px 16px;min-width:130px}
    .card .lbl{font-size:10px;color:#888;margin-bottom:3px}
    .card .val{font-size:14px;font-weight:700}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a7a2e;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}
    tr:nth-child(even) td{background:#f9f9f9}
    td:last-child{text-align:right;font-weight:600}
    .footer{margin-top:16px;font-size:10px;color:#888;text-align:center}
    @media print{body{padding:6px}@page{margin:8mm}}
  </style>
  </head><body>
  <h1>${nomeRestaurante} — Relatório Financeiro</h1>
  <div class="sub">Período: ${periodoLabel} &nbsp;|&nbsp; Gerado em: ${new Date().toLocaleString("pt-BR")}</div>
  <div class="resumo">
    <div class="card"><div class="lbl">Total Faturado</div><div class="val">${fmt(total)}</div></div>
    <div class="card"><div class="lbl">Pedidos</div><div class="val">${pedidos.length}</div></div>
    <div class="card"><div class="lbl">Ticket Médio</div><div class="val">${fmt(pedidos.length ? Math.round(total / pedidos.length) : 0)}</div></div>
    <div class="card"><div class="lbl">Pix</div><div class="val">${fmt(totalPix)}</div></div>
    <div class="card"><div class="lbl">Dinheiro</div><div class="val">${fmt(totalEfet)}</div></div>
    <div class="card"><div class="lbl">Cartão PY</div><div class="val">${fmt(totalCard)}</div></div>
    <div class="card"><div class="lbl">Cartão BR</div><div class="val">${fmt(totalCartaoBR)}</div></div>
    <div class="card"><div class="lbl">Transferência</div><div class="val">${fmt(totalTransf)}</div></div>
    <div class="card"><div class="lbl">QR Paraguay</div><div class="val">${fmt(totalQrPy)}</div></div>
    ${totalMulti > 0 ? `<div class="card"><div class="lbl">Multi/Outros</div><div class="val">${fmt(totalMulti)}</div></div>` : ""}
  </div>
  <table>
    <thead><tr><th>#</th><th>Data/Hora</th><th>Cliente</th><th>Itens</th><th>Pagamento</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">${nomeRestaurante} &nbsp;·&nbsp; ${new Date().toLocaleDateString("pt-BR")} &nbsp;·&nbsp; ${pedidos.length} registros</div>
  <script>window.onload=()=>window.print();<\/script>
  </body></html>`;

  const w = window.open("", "PDF", "width=900,height=700");
  w.document.write(html);
  w.document.close();
}

// =========================================
// 7. ZAP & ROTA
// =========================================
function enviarRotaZap() {
  const checks = document.querySelectorAll(".check-pedido:checked");
  const selMoto = document.getElementById("sel-motoboy");

  if (checks.length === 0 || !selMoto.value)
    return alert(t("alert.sel_pedidos_moto"));

  // Pega dados do motoboy selecionado
  const opt = selMoto.options[selMoto.selectedIndex];
  // Fallback: se não tiver dataset, tenta pegar do texto
  const nomeMoto = opt.dataset.nome || opt.text;
  const telMoto = opt.dataset.tel || ""; // Importante ter o telefone no value ou dataset

  let msg = `🛵 *ROTA - ${nomeMoto.toUpperCase()}*\n\n`;
  let coords = [];
  let taxaTotal = 0;

  checks.forEach((chk) => {
    try {
      // Agora 'p' tem o objeto COMPLETO do banco
      const p = JSON.parse(decodeURIComponent(chk.value));

      // Atualiza status no banco para "saiu_entrega" ou "entregue"
      supa
        .from("pedidos")
        .update({ status: "saiu_entrega", motoboy_id: selMoto.value })
        .eq("id", p.id)
        .then();

      msg += `📦 *PEDIDO #${p.uid_temporal || p.id}*\n`;
      msg += `👤 ${p.cliente_nome || "Cliente"} | 📞 ${p.cliente_telefone || ""}\n`;

      if (p.itens && Array.isArray(p.itens)) {
        // Separa bebidas (para levar imediatamente) do restante
        const _esBebida = (i) => {
          if (i.es_bebida) return true;
          const cat = (i.categoria_slug || i.cat || "").toLowerCase();
          const _SLUGS_BEBIDA = [
            "bebida",
            "bebidas",
            "drink",
            "drinks",
            "refrigerante",
            "refrigerantes",
            "gaseosa",
            "gaseosas",
            "suco",
            "sucos",
            "jugo",
            "jugos",
            "cerveja",
            "cervejas",
            "cerveza",
            "cervezas",
            "trago",
            "tragos",
            "licor",
            "licores",
            "agua",
            "aguas",
            "água",
            "águas",
            "vino",
            "vinos",
            "vinho",
            "vinhos",
          ];
          return _SLUGS_BEBIDA.some((s) => cat === s || cat.includes(s));
        };
        const bebidas = p.itens.filter(_esBebida);
        const naoFoodKds = p.itens.filter((i) => !_esBebida(i));

        // Helper: formata um item com variação + montagem
        const _fmtItem = (b) => {
          let txt = `${b.qtd || b.q || 1}x ${b.nome || b.n}`;
          const v = b.variacao || b.t || "";
          if (v) txt += ` (${v})`;
          const mont = b.montagem || b.m || [];
          if (Array.isArray(mont) && mont.length) {
            const itensStr = mont
              .map((x) => (typeof x === "object" ? x.nome || "" : x))
              .filter(Boolean)
              .join(", ");
            if (itensStr) txt += ` [${itensStr}]`;
          }
          if (b.obs || b.o) txt += ` ⚠ ${b.obs || b.o}`;
          return txt;
        };

        if (bebidas.length > 0) {
          const lista = bebidas.map(_fmtItem).join(", ");
          msg += `🥤 *LEVAR:* ${lista}\n`;
        }
        // Nota sobre outros itens (já ficam na cozinha, info útil para motoboy saber o que pegar)
        if (naoFoodKds.length > 0) {
          msg += `📦 *Itens:* ` + naoFoodKds.map(_fmtItem).join(" | ") + `\n`;
        }
      }

      // LÓGICA DE MAPA
      if (p.geo_lat && p.geo_lng) {
        const link = `https://www.google.com/maps/search/?api=1&query=${p.geo_lat},${p.geo_lng}`;
        msg += `📍 ${link}\n`;
        coords.push(`${p.geo_lat},${p.geo_lng}`);
      } else {
        msg += `🏠 ${p.endereco_entrega || "Retirada"}\n`;
      }

      // LÓGICA DE PAGAMENTO
      const forma = (p.forma_pagamento || "").toLowerCase();
      const totalGeral = p.total_geral || 0;
      const totalFmt = totalGeral.toLocaleString("es-PY");

      if (
        forma.includes("pix") ||
        forma.includes("transfer") ||
        forma.includes("alias")
      ) {
        msg += `✅ *PAGO (Pix/Transf)*\n`;
      } else if (
        forma.includes("cartao") ||
        forma.includes("credito") ||
        forma.includes("debito")
      ) {
        msg += `💳 *Cobrar Cartão: Gs ${totalFmt}*\n`;
      } else {
        msg += `💰 *COBRAR: Gs ${totalFmt}*\n`;

        const obsPag = p.obs_pagamento || "";
        const nums = obsPag.match(/\d+/g);
        if (nums) {
          let valorTroco = parseInt(nums.join(""));
          if (valorTroco < 1000) valorTroco *= 1000;
          if (valorTroco > totalGeral) {
            const devolver = valorTroco - totalGeral;
            msg += `🔄 Troco p/ ${valorTroco.toLocaleString()} (Levar Gs ${devolver.toLocaleString()})\n`;
          }
        }
        if (obsPag && !nums) msg += `⚠️ Obs: ${obsPag}\n`;
      }

      msg += `-----------------\n`;
      const _freteM = parseFloat(p.frete_motoboy);
      taxaTotal += isNaN(_freteM) ? TAXA_MOTOBOY || 0 : _freteM;
    } catch (e) {
      console.error("Erro ao processar pedido na rota:", e);
    }
  });

  // MAPA GERAL DA ROTA
  if (coords.length > 0) {
    // Usa coordenadas da loja se existirem, senão usa padrão
    const latLoja = typeof COORD_LOJA !== "undefined" ? COORD_LOJA.lat : "";
    const lngLoja = typeof COORD_LOJA !== "undefined" ? COORD_LOJA.lng : "";
    const rota = `https://www.google.com/maps/dir/${latLoja},${lngLoja}/${coords.join("/")}`;
    msg += `\n🗺️ *ROTA NO MAPA:*\n${rota}\n`;
  }

  msg += `\n🏍️ *Taxa Total: Gs ${taxaTotal.toLocaleString("es-PY")}*`;

  // Abre WhatsApp
  const foneDestino = telMoto || ""; // Se tiver numero no cadastro do motoboy
  window.open(
    `https://wa.me/${foneDestino}?text=${encodeURIComponent(msg)}`,
    "_blank",
  );

  // Recarrega a tela depois de um tempo para atualizar os status
  setTimeout(() => {
    if (typeof carregarPedidos === "function") carregarPedidos();
    if (typeof calcularFinanceiro === "function") calcularFinanceiro();
  }, 2000);
}

// =========================================
// 8. PRODUTOS E CRUD COMPLETO (RESTAURADO)
// =========================================
// Cache dos produtos para filtro local
let _todosProdutos = [];
let _produtosMap = {}; // mapa id→produto para onclick seguro sem JSON inline

// ══════════════════════════════════════════════════════════════
//  CÓDIGO DE BARRAS — Scanner (câmera) + Busca PDV
// ══════════════════════════════════════════════════════════════

/**
 * Abre o scanner de código de barras via câmera do dispositivo.
 * Usa a Barcode Detection API (nativa em Android/Chrome) com fallback
 * para input manual.
 */
async function abrirScannerBarcode() {
  const campo = document.getElementById("prod-codigo-barras");
  if (!campo) return;

  // ── Barcode Detection API (Chrome Android / Edge) ──────────
  if ("BarcodeDetector" in window) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });

      // Cria overlay de câmera
      const overlay = document.createElement("div");
      overlay.id = "_barcode-overlay";
      overlay.style.cssText = `
        position:fixed; inset:0; z-index:99999; background:#000;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        font-family:'Rubik',sans-serif;
      `;
      overlay.innerHTML = `
        <p style="color:#fff; font-size:0.9rem; margin-bottom:12px; opacity:0.8">
          📷 Aponte para o código de barras
        </p>
        <video id="_barcode-video" autoplay playsinline
          style="width:100%; max-width:420px; border-radius:12px; border:2px solid #22c55e"></video>
        <div style="width:100%; max-width:420px; height:3px; background:transparent; position:relative; margin-top:-50%; pointer-events:none">
          <div style="position:absolute; left:0; right:0; height:2px; background:#22c55e; opacity:0.8; animation:_scanLine 1.5s ease-in-out infinite alternate; top:0"></div>
        </div>
        <style>@keyframes _scanLine { from { top:0 } to { top:100px } }</style>
        <button onclick="document.getElementById('_barcode-overlay').remove(); window._barcodeStream?.getTracks().forEach(t=>t.stop())"
          style="margin-top:20px; padding:12px 28px; background:#ef4444; color:#fff; border:none;
                 border-radius:8px; font-size:0.9rem; font-weight:700; cursor:pointer">
          ✕ Cancelar
        </button>
      `;
      document.body.appendChild(overlay);

      const video = document.getElementById("_barcode-video");
      video.srcObject = stream;
      window._barcodeStream = stream;

      const detector = new BarcodeDetector({
        formats: [
          "ean_13",
          "ean_8",
          "upc_a",
          "upc_e",
          "code_128",
          "code_39",
          "qr_code",
        ],
      });

      const tick = async () => {
        if (!document.getElementById("_barcode-overlay")) return; // foi fechado
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const code = barcodes[0].rawValue;
            campo.value = code;
            stream.getTracks().forEach((t) => t.stop());
            overlay.remove();
            // Feedback visual
            campo.style.borderColor = "#22c55e";
            setTimeout(() => (campo.style.borderColor = ""), 2000);
            // Tenta buscar produto existente com esse barcode
            await _verificarBarcodeExistente(code);
            return;
          }
        } catch (_) {}
        requestAnimationFrame(tick);
      };
      video.addEventListener("play", () => requestAnimationFrame(tick));
      return;
    } catch (err) {
      console.warn("[Barcode] Câmera negada ou API falhou:", err.message);
    }
  }

  // ── Fallback: prompt manual ────────────────────────────────
  const manual = prompt(
    "📷 Scanner não disponível.\nDigite ou cole o código de barras:",
  );
  if (manual?.trim()) {
    campo.value = manual.trim();
    await _verificarBarcodeExistente(manual.trim());
  }
}

/**
 * Avisa se o código já está cadastrado em outro produto.
 */
async function _verificarBarcodeExistente(codigo) {
  if (!codigo) return;
  const idAtual = document.getElementById("prod-id")?.value;
  const { data } = await supa
    .from("produtos")
    .select("id, nome")
    .eq("codigo_barras", codigo)
    .maybeSingle();

  if (data && String(data.id) !== String(idAtual)) {
    alert(
      `⚠️ Este código já pertence ao produto:\n"${data.nome}" (ID ${data.id})\n\nVerifique antes de salvar.`,
    );
  }
}

/**
 * Busca um produto pelo código de barras.
 * Usada pelo PDV quando um leitor USB/BT envia o código.
 * @param {string} codigo
 * @returns {Promise<object|null>}
 */
async function buscarProdutoPorBarcode(codigo) {
  if (!codigo?.trim()) return null;
  const { data, error } = await supa
    .from("produtos")
    .select("*")
    .eq("codigo_barras", codigo.trim())
    .eq("ativo", true)
    .maybeSingle();
  if (error) {
    console.error("[Barcode PDV]", error.message);
    return null;
  }
  return data;
}

// ── Listener global para leitor USB/Bluetooth no PDV ────────
// Leitores HID digitam o código + Enter rapidamente.
// Detectamos pela velocidade de entrada (< 50ms entre chars).
(function _initBarcodeListener() {
  let _buf = "",
    _last = 0;
  const PDV_TABS = ["pdv"]; // abas onde o listener é ativo

  document.addEventListener("keydown", async (e) => {
    // Só na aba PDV
    const abaAtiva = document.querySelector(".tab-btn.active")?.dataset?.tab;
    if (!PDV_TABS.includes(abaAtiva)) return;

    // Bloqueia se o foco estiver em qualquer input EXCETO o campo de busca do PDV
    // (o leitor USB pode colocar o foco em #pdv-busca ao digitar)
    const tag = document.activeElement?.tagName;
    const isPdvBusca = document.activeElement?.id === "pdv-busca";
    if (
      (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") &&
      !isPdvBusca
    )
      return;

    const now = Date.now();
    if (now - _last > 80) _buf = ""; // reset se demorou muito
    _last = now;

    if (e.key === "Enter" && _buf.length >= 6) {
      e.preventDefault();
      const produto = await buscarProdutoPorBarcode(_buf);
      if (produto) {
        if (_pdvF2Mode) {
          // Modo F2: apenas exibe o preço, NÃO adiciona ao carrinho
          _pdvMostrarToast(
            `🔍 ${produto.nome} — Gs ${produto.preco.toLocaleString("es-PY")}`,
            "#1565c0",
            3000,
          );
        } else {
          // Modo normal: adiciona ao carrinho
          if (typeof adicionarItemPDV === "function") adicionarItemPDV(produto);
          _pdvMostrarToast(`✅ ${produto.nome} adicionado!`, "#16a34a", 2000);
        }
      } else {
        _pdvMostrarToast(`❌ Código ${_buf} não encontrado`, "#ef4444", 2500);
      }
      _buf = "";
    } else if (e.key.length === 1) {
      _buf += e.key;
    }
  });
})();

// Retorna true se algum filtro do painel de produtos está ativo
function _ptFiltrosAtivos() {
  const cat = document.getElementById("pt-filtro-cat")?.value || "";
  const estoque = document.getElementById("pt-filtro-estoque")?.value || "";
  const validade = document.getElementById("pt-filtro-validade")?.value || "";
  const destaque = document.getElementById("pt-filtro-destaque")?.value || "";
  const ordem = document.getElementById("pt-filtro-ordem")?.value || "nome_az";
  const busca = (
    document.getElementById("pt-filtro-busca-rapida")?.value || ""
  ).trim();
  const apenasEstoque = document
    .getElementById("pt-toggle-estoque")
    ?.classList.contains("on");
  return (
    cat ||
    estoque ||
    validade ||
    destaque ||
    busca ||
    apenasEstoque ||
    (ordem && ordem !== "nome_az")
  );
}

async function carregarProdutos() {
  const { data } = await supa.from("produtos").select("*").order("nome");
  _todosProdutos = data || [];
  _produtosMap = {};
  _todosProdutos.forEach((p) => {
    _produtosMap[p.id] = p;
  });

  // Reaaplica filtros ativos se houver algum selecionado, senão renderiza tudo
  if (_ptFiltrosAtivos()) {
    ptAplicarFiltros();
  } else {
    renderizarCardsProdutos(_todosProdutos);
  }
  atualizarStatsProdutos(_todosProdutos);
  // Só recarrega o select de categorias se o modal de produto estiver fechado
  const modalAberto =
    document.getElementById("modal-produto")?.style.display === "flex";
  if (!modalAberto) carregarSelectCategorias();

  // Popula filtro de categoria na tela de produtos
  await ptPopularFiltroCategoria();

  // ── Alerta de estoque baixo (varejo) ──────────────────────
  veVerificarEstoqueBaixo(5);
  // ── Alerta de validade próxima (produtos) ─────────────────
  ptVerificarValidadeProdutos(7);
  // ── Fim alertas ────────────────────────────────────────────
}

function atualizarStatsProdutos(lista) {
  const total = lista.length;
  const estoqueTotal = lista.reduce((s, p) => s + (p.estoque_qtd || 0), 0);
  const zerados = lista.filter(
    (p) =>
      p.estoque_qtd !== null &&
      p.estoque_qtd !== undefined &&
      p.estoque_qtd <= 0,
  ).length;
  const destaques = lista.filter((p) => p.destaque).length;
  const el = (id) => document.getElementById(id);
  if (el("pt-stat-total")) el("pt-stat-total").textContent = total;
  if (el("pt-stat-estoque"))
    el("pt-stat-estoque").textContent =
      estoqueTotal.toLocaleString("es-PY") + " un";
  if (el("pt-stat-zerado")) el("pt-stat-zerado").textContent = zerados;
  if (el("pt-stat-destaque")) el("pt-stat-destaque").textContent = destaques;
}

function ptAplicarFiltros() {
  let lista = [..._todosProdutos];
  const cat = document.getElementById("pt-filtro-cat")?.value || "";
  const estoque = document.getElementById("pt-filtro-estoque")?.value || "";
  const validade = document.getElementById("pt-filtro-validade")?.value || "";
  const destaque = document.getElementById("pt-filtro-destaque")?.value || "";
  const ordem = document.getElementById("pt-filtro-ordem")?.value || "nome_az";
  const busca = (
    document.getElementById("pt-filtro-busca-rapida")?.value || ""
  ).toLowerCase();
  const apenasEstoque = document
    .getElementById("pt-toggle-estoque")
    ?.classList.contains("on");
  if (cat) lista = lista.filter((p) => p.categoria_slug === cat);
  if (estoque === "em_estoque") lista = lista.filter((p) => p.estoque_qtd > 0);
  if (estoque === "zerado")
    lista = lista.filter((p) => p.estoque_qtd !== null && p.estoque_qtd <= 0);
  if (estoque === "sem_controle")
    lista = lista.filter(
      (p) => p.estoque_qtd === null || p.estoque_qtd === undefined,
    );
  if (destaque === "sim") lista = lista.filter((p) => p.destaque);
  if (destaque === "nao") lista = lista.filter((p) => !p.destaque);
  if (validade) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    lista = lista.filter((p) => {
      if (!p.validade) return false;
      const d = new Date(p.validade + "T00:00:00");
      const diff = Math.round((d - hoje) / 86400000);
      if (validade === "vencido") return diff < 0;
      if (validade === "proximo") return diff >= 0 && diff <= 3;
      if (validade === "ok") return diff > 3;
      return true;
    });
  }
  if (busca) {
    lista = lista.filter(
      (p) =>
        p.nome.toLowerCase().includes(busca) ||
        (p.categoria_slug || "").toLowerCase().includes(busca) ||
        String(p.id).includes(busca) ||
        (p.codigo_barras || "").toLowerCase().includes(busca),
    );
  }
  if (apenasEstoque) lista = lista.filter((p) => p.estoque_qtd > 0);
  lista.sort((a, b) => {
    if (ordem === "nome_az") return a.nome.localeCompare(b.nome);
    if (ordem === "nome_za") return b.nome.localeCompare(a.nome);
    if (ordem === "preco_asc") return (a.preco || 0) - (b.preco || 0);
    if (ordem === "preco_desc") return (b.preco || 0) - (a.preco || 0);
    if (ordem === "estoque_asc")
      return (a.estoque_qtd || 0) - (b.estoque_qtd || 0);
    if (ordem === "estoque_desc")
      return (b.estoque_qtd || 0) - (a.estoque_qtd || 0);
    return 0;
  });
  renderizarCardsProdutos(lista);
}

async function ptPopularFiltroCategoria() {
  const sel = document.getElementById("pt-filtro-cat");
  if (!sel) return;
  const valorAtual = sel.value;
  // Busca todas as categorias com ativo=true OU ativa=true (tabela tem os dois campos)
  const { data: cats, error } = await supa
    .from("categorias")
    .select("slug, nome_exibicao, ativo, ativa")
    .or("ativo.eq.true,ativa.eq.true")
    .order("ordem");
  if (error) {
    console.warn("[ptPopularFiltroCategoria]", error.message);
    return;
  }
  if (!cats || cats.length === 0) {
    console.warn("[ptPopularFiltroCategoria] Nenhuma categoria retornada");
    return;
  }
  sel.innerHTML = '<option value="">Todas as categorias</option>';
  cats.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.slug;
    opt.textContent = c.nome_exibicao;
    if (c.slug === valorAtual) opt.selected = true;
    sel.appendChild(opt);
  });
  console.log("[ptPopularFiltroCategoria] Categorias carregadas:", cats.length);
}

function ptLimparFiltros() {
  [
    "pt-filtro-cat",
    "pt-filtro-estoque",
    "pt-filtro-validade",
    "pt-filtro-destaque",
    "pt-filtro-busca-rapida",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const ordem = document.getElementById("pt-filtro-ordem");
  if (ordem) ordem.value = "nome_az";
  const toggle = document.getElementById("pt-toggle-estoque");
  if (toggle) toggle.classList.remove("on");
  ptBulkDesmarcarTodos();
  renderizarCardsProdutos(_todosProdutos);
}

function ptToggleApenasEstoque(btn) {
  btn.classList.toggle("on");
  ptAplicarFiltros();
}

function filtrarProdutos(termo) {
  if (!termo.trim()) {
    renderizarCardsProdutos(_todosProdutos);
    return;
  }
  const t = termo.toLowerCase();
  const filtrados = _todosProdutos.filter(
    (p) =>
      p.nome.toLowerCase().includes(t) ||
      (p.categoria_slug || "").toLowerCase().includes(t),
  );
  renderizarCardsProdutos(filtrados);
}

function renderizarCardsProdutos(lista) {
  const grid = document.getElementById("lista-produtos-grid");
  if (!grid) return;

  // ── Manage table header visibility ─────────────────────────
  const header = document.getElementById("produtos-table-header");

  // ── Barra de ações em massa ─────────────────────────────────
  let barraAcoes = document.getElementById("pt-bulk-actions-bar");
  if (!barraAcoes) {
    barraAcoes = document.createElement("div");
    barraAcoes.id = "pt-bulk-actions-bar";
    barraAcoes.style.cssText = `
      display:none; align-items:center; gap:10px; flex-wrap:wrap;
      background:#fff; border:1px solid #e2e8f0; border-radius:10px;
      padding:8px 14px; margin-bottom:8px;
      box-shadow:0 1px 4px rgba(0,0,0,0.06);
    `;
    barraAcoes.innerHTML = `
      <span id="pt-bulk-count" style="font-size:0.82rem;font-weight:700;color:#334155"></span>
      <button onclick="ptBulkPausar()" style="
        padding:6px 14px;background:#f97316;color:#fff;border:none;border-radius:7px;
        font-size:0.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-pause"></i> Pausar selecionados
      </button>
      <button onclick="ptBulkExcluir()" style="
        padding:6px 14px;background:#ef4444;color:#fff;border:none;border-radius:7px;
        font-size:0.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-trash"></i> Excluir selecionados
      </button>
      <button onclick="ptBulkDesmarcarTodos()" style="
        padding:6px 10px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;border-radius:7px;
        font-size:0.8rem;cursor:pointer">
        ✕ Desmarcar todos
      </button>
    `;
    grid.parentNode.insertBefore(barraAcoes, grid);
  }

  grid.innerHTML = "";

  if (!lista || lista.length === 0) {
    if (header) header.style.display = "none";
    if (barraAcoes) barraAcoes.style.display = "none";
    grid.innerHTML =
      '<p style="color:#bbb;font-size:0.9rem;padding:20px 0">Nenhum produto encontrado.</p>';
    return;
  }
  if (header) {
    header.style.display = "";
  }

  const _TIPO_ICONS = {
    padrao: "📦",
    bebida: "🥤",
    lanche: "🍔",
    pizza: "🍕",
    acai: "🍇",
    shake: "🥤",
    suco: "🍊",
    sorvete: "🍦",
    montavel: "🥗",
    almoco: "🍽️",
    combo: "⭐",
  };

  lista.forEach((p) => {
    const cfg = p.montagem_config;
    let tipoKey = "padrao";
    if (cfg && !Array.isArray(cfg) && cfg.__tipo) tipoKey = cfg.__tipo;
    else if (p.e_montavel || (cfg && Array.isArray(cfg) && cfg.length > 0))
      tipoKey = "montavel";

    const tipoIcon = _TIPO_ICONS[tipoKey] || "📦";

    // ── Image ────────────────────────────────────────────────
    const imgHtml = p.imagem_url
      ? `<img src="${p.imagem_url}" alt="${p.nome}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">`
      : `<div class="produto-card-img-placeholder">${tipoIcon}</div>`;

    // ── Estoque ──────────────────────────────────────────────
    const semCtrl = p.estoque_qtd === null || p.estoque_qtd === undefined;
    const qtd = semCtrl ? "—" : p.estoque_qtd;
    const estoqueStatusClass = semCtrl
      ? ""
      : p.estoque_qtd > 0
        ? "estoque-ok"
        : "estoque-zero";
    const estoqueStatusLabel = semCtrl
      ? ""
      : p.estoque_qtd > 0
        ? "Em estoque"
        : "Sem estoque";
    const estoqueBadge = semCtrl
      ? `<span class="produto-card-estoque-qty">—</span>`
      : `<span class="produto-card-estoque-qty">${qtd} un</span>
         <span class="produto-card-estoque-status ${estoqueStatusClass}">${estoqueStatusLabel}</span>`;

    // ── Validade ─────────────────────────────────────────────
    let validadeHtml = `<span style="color:#cbd5e1">—</span>`;
    if (p.validade) {
      const d = new Date(p.validade + "T00:00:00");
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const diff = Math.round((d - hoje) / 86400000);
      const fmt = d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
      });
      const cor = diff < 0 ? "#dc2626" : diff <= 3 ? "#f59e0b" : "#94a3b8";
      validadeHtml = `<span style="color:${cor};font-size:0.75rem">${fmt}</span>`;
    }

    // ── Badge pausado ────────────────────────────────────────
    const badgePausado = !p.ativo
      ? `<span class="badge-pausado" style="font-size:0.6rem">⏸ Pausado</span>`
      : "";

    // ── Produto info (meta) ──────────────────────────────────
    const slugLabel = (p.categoria_slug || "").substring(0, 22);
    const eanHtml = p.codigo_barras
      ? `<span style="font-size:0.65rem;color:#94a3b8;font-family:monospace">${p.codigo_barras}</span>`
      : "";

    const card = document.createElement("div");
    card.className = `produto-card${!p.ativo ? " pausado" : ""}`;
    card.dataset.prodId = p.id;
    card.style.gridTemplateColumns = "32px 2.8fr 90px 130px 100px 70px 120px";
    card.innerHTML = `
      <!-- Col 0: Checkbox -->
      <div style="display:flex;align-items:center;justify-content:center">
        <input type="checkbox" class="pt-chk-produto"
          data-id="${p.id}"
          style="width:15px;height:15px;cursor:pointer;accent-color:#1a7a2e"
          onchange="ptAtualizarBarraBulk()">
      </div>
      <!-- Col 1: Produto -->
      <div class="produto-card-info">
        <div class="produto-card-img-wrap">${imgHtml}</div>
        <div class="produto-card-meta-wrap" style="min-width:0">
          <div class="produto-card-nome">${p.nome}</div>
          <div class="produto-card-meta" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px">
            <span class="produto-card-cat" style="color:#94a3b8;font-size:0.7rem">${slugLabel}</span>
            <span class="produto-card-id" style="color:#cbd5e1;font-size:0.68rem">#${p.id}</span>
            ${eanHtml}
            ${badgePausado}
          </div>
        </div>
      </div>
      <!-- Col 2: Preço -->
      <div class="produto-card-preco">Gs ${(p.preco || 0).toLocaleString("es-PY")}</div>
      <!-- Col 3: Estoque -->
      <div class="produto-card-estoque">${estoqueBadge}</div>
      <!-- Col 4: Validade -->
      <div class="produto-card-validade">${validadeHtml}</div>
      <!-- Col 5: Destaque -->
      <div class="produto-card-destaque">
        <button class="btn-destaque${p.destaque ? " ativo" : ""}"
          onclick="toggleDestaqueProduto(${p.id}, ${!!p.destaque})"
          title="${p.destaque ? "Remover destaque" : "Marcar como destaque"}">
          ${p.destaque ? "★" : "☆"}
        </button>
      </div>
      <!-- Col 6: Ações -->
      <div class="produto-card-actions">
        <button class="btn-print-barcode" onclick="imprimirCodigoBarras('${p.codigo_barras || ''}', '${p.nome.replace(/'/g, "\\'")}', 'Gs ${(p.preco || 0).toLocaleString('es-PY')}')">
            <i class="fas fa-barcode"></i> Imprimir Etiqueta
        </button>
        <button class="btn btn-sm btn-primary" onclick="editarProdutoById(${p.id})" title="Editar">
          <i class="fas fa-edit"></i>
        </button>
        <button class="btn btn-sm btn-info" onclick="duplicarProduto(${p.id})" title="Duplicar">
          <i class="fas fa-copy"></i>
        </button>
        <button class="btn btn-sm ${p.ativo ? "btn-warning" : "btn-success"}"
          onclick="pausarProduto(${p.id}, ${p.ativo})"
          title="${p.ativo ? "Pausar" : "Reativar"}" style="background:${p.ativo ? "#f97316" : "#22c55e"}">
          <i class="fas fa-${p.ativo ? "pause" : "play"}"></i>
        </button>
        <button class="btn btn-sm btn-danger" onclick="deletarProduto(${p.id})" title="Excluir">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

// =========================================
// BULK ACTIONS — Seleção e ações em massa
// =========================================

function ptAtualizarBarraBulk() {
  const checkboxes = document.querySelectorAll(".pt-chk-produto");
  const selecionados = document.querySelectorAll(".pt-chk-produto:checked");
  const barra = document.getElementById("pt-bulk-actions-bar");
  const chkTodos = document.getElementById("pt-chk-todos");

  if (barra) {
    if (selecionados.length > 0) {
      barra.style.display = "flex";
      const countEl = document.getElementById("pt-bulk-count");
      if (countEl)
        countEl.textContent = `${selecionados.length} produto(s) selecionado(s)`;
    } else {
      barra.style.display = "none";
    }
  }

  // Atualiza estado do checkbox "selecionar todos"
  if (chkTodos) {
    chkTodos.indeterminate =
      selecionados.length > 0 && selecionados.length < checkboxes.length;
    chkTodos.checked =
      checkboxes.length > 0 && selecionados.length === checkboxes.length;
  }

  // Destaca visualmente os cards selecionados
  document.querySelectorAll(".pt-chk-produto").forEach((chk) => {
    const card = chk.closest(".produto-card");
    if (card) {
      card.style.outline = chk.checked ? "2px solid #1a7a2e" : "";
      card.style.background = chk.checked ? "#f0fdf4" : "";
    }
  });
}

function ptToggleSelecionarTodos(checked) {
  document.querySelectorAll(".pt-chk-produto").forEach((chk) => {
    chk.checked = checked;
  });
  ptAtualizarBarraBulk();
}

function ptBulkDesmarcarTodos() {
  document.querySelectorAll(".pt-chk-produto").forEach((chk) => {
    chk.checked = false;
  });
  const chkTodos = document.getElementById("pt-chk-todos");
  if (chkTodos) {
    chkTodos.checked = false;
    chkTodos.indeterminate = false;
  }
  ptAtualizarBarraBulk();
}

function _ptGetIdsSelecionados() {
  return Array.from(document.querySelectorAll(".pt-chk-produto:checked"))
    .map((chk) => parseInt(chk.dataset.id))
    .filter(Boolean);
}

async function ptBulkPausar() {
  const ids = _ptGetIdsSelecionados();
  if (!ids.length) return;

  // Verifica estado atual dos selecionados para decidir a ação
  const produtosSel = ids.map((id) => _produtosMap[id]).filter(Boolean);
  const algumAtivo = produtosSel.some((p) => p.ativo);
  const acao = algumAtivo ? "pausar" : "reativar";
  const novoStatus = algumAtivo ? false : true;

  if (!confirm(`Deseja ${acao} ${ids.length} produto(s) selecionado(s)?`))
    return;

  try {
    const { error } = await supa
      .from("produtos")
      .update({ ativo: novoStatus })
      .in("id", ids);

    if (error) {
      alert("❌ Erro: " + error.message);
    } else {
      const msg = novoStatus
        ? `✅ ${ids.length} produto(s) reativado(s)!`
        : `⏸️ ${ids.length} produto(s) pausado(s)!`;
      if (typeof mostrarToast === "function")
        mostrarToast(msg, "success", 3000);
      else alert(msg);
      ptBulkDesmarcarTodos();
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

async function ptBulkExcluir() {
  const ids = _ptGetIdsSelecionados();
  if (!ids.length) return;

  if (
    !confirm(
      `⚠️ ATENÇÃO: Excluir permanentemente ${ids.length} produto(s) selecionado(s)?\n\nEsta ação não pode ser desfeita.`,
    )
  )
    return;

  try {
    const { error } = await supa.from("produtos").delete().in("id", ids);

    if (error) {
      alert("❌ Erro ao excluir: " + error.message);
    } else {
      const msg = `🗑️ ${ids.length} produto(s) excluído(s) com sucesso!`;
      if (typeof mostrarToast === "function")
        mostrarToast(msg, "success", 3000);
      else alert(msg);
      ptBulkDesmarcarTodos();
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

// Toggle destaque inline without opening modal
async function toggleDestaqueProduto(id, atualDestaque) {
  try {
    await supa
      .from("produtos")
      .update({ destaque: !atualDestaque })
      .eq("id", id);
    const p = _produtosMap[id];
    if (p) {
      p.destaque = !atualDestaque;
      // Update button in place
      const btn = document.querySelector(
        `.btn-destaque[onclick*="toggleDestaqueProduto(${id},"]`,
      );
      if (btn) {
        btn.className = `btn-destaque${!atualDestaque ? " ativo" : ""}`;
        btn.innerHTML = !atualDestaque ? "★" : "☆";
        btn.setAttribute(
          "onclick",
          `toggleDestaqueProduto(${id}, ${!atualDestaque})`,
        );
        btn.title = !atualDestaque
          ? "Remover destaque"
          : "Marcar como destaque";
      }
      // Update stat counter
      const statDest = document.getElementById("pt-stat-destaque");
      if (statDest) {
        const cnt = _todosProdutos.filter((x) => x.destaque).length;
        statDest.textContent = cnt;
      }
    }
  } catch (e) {
    console.error("Erro ao alternar destaque:", e);
  }
}

function editarProdutoById(id) {
  const p = _produtosMap[id];
  if (p) editarProduto(p);
}

function editarProduto(p) {
  abrirModalProduto(p);
}

// (deletarProduto defined below alongside pausarProduto)

// Preview ao colar/digitar URL de imagem no campo de texto
function previewUrlImagem(url) {
  const box = document.getElementById("box-preview");
  const img = document.getElementById("img-preview");
  if (!box || !img) return;
  const trimmed = (url || "").trim();
  if (!trimmed) {
    box.style.display = "none";
    img.src = "";
    return;
  }
  img.src = trimmed;
  box.style.display = "block";
  img.onerror = () => {
    box.style.display = "none";
  };
  img.onload = () => {
    box.style.display = "block";
  };
}

function previewUpload(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function (e) {
      document.getElementById("img-preview").src = e.target.result;
      document.getElementById("box-preview").style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  }
}

async function salvarProduto() {
  const btn = event.target;
  btn.disabled = true;
  try {
    const id = document.getElementById("prod-id").value;
    const fileInput = document.getElementById("prod-img-file");
    let urlFinal = document.getElementById("prod-img").value;

    // ── Upload para o Cloudinary ──────────────────────────────
    console.log(
      "[salvarProduto] fileInput.files.length:",
      fileInput.files.length,
      "| urlFinal atual:",
      urlFinal,
    );
    if (fileInput.files.length > 0) {
      btn.innerText = "📤 Enviando imagem...";
      try {
        urlFinal = await uploadImageToImgbb(fileInput.files[0]);
        // Atualiza o campo de URL para refletir o resultado
        document.getElementById("prod-img").value = urlFinal;
        document.getElementById("img-preview").src = urlFinal;
        document.getElementById("box-preview").style.display = "block";
      } catch (uploadErr) {
        btn.disabled = false;
        btn.innerText = "Salvar Produto";
        alert(
          "❌ Falha no upload da imagem:\n\n" +
            uploadErr.message +
            "\n\nSe quiser, cole a URL da imagem diretamente no campo de URL e salve novamente.",
        );
        return;
      }
    } else if (urlFinal && urlFinal.trim()) {
      // URL digitada manualmente — usa direto, sem upload
      urlFinal = urlFinal.trim();
    }

    btn.innerText = "Salvando...";

    const tipo = document.getElementById("prod-tipo-builder").value || "padrao";

    // Valida campos obrigatórios
    const _nomeVal = document.getElementById("prod-nome").value.trim();
    if (!_nomeVal) {
      alert("⚠️ O nome do produto é obrigatório.");
      return;
    }
    const _catVal = document.getElementById("prod-cat").value;
    if (!_catVal) {
      alert("⚠️ Selecione uma categoria para o produto.");
      return;
    }

    // ── Combo: exige ao menos 1 componente válido ──────────────
    const _tipoProdutoVal = document.getElementById("prod-tipo-produto")?.value || "simples";
    if (_tipoProdutoVal === "combo" && comboColetarComponentes().length === 0) {
      alert("⚠️ Adicione ao menos um componente ao combo.");
      return;
    }

    // Preço base — usa dataset.valorNumerico (setado pela máscara) para evitar que
    // parseInt("12.000") retorne 12 ao encontrar o ponto separador de milhar paraguaio
    const _precoEl = document.getElementById("prod-preco");
    let precoBase =
      parseInt(
        _precoEl?.dataset?.valorNumerico ||
          (_precoEl?.value || "").replace(/\D/g, "") ||
          "0",
        10,
      ) || 0;
    if (document.getElementById("prod-venda-kg")?.checked) {
      const pkgVal =
        parseFloat(document.getElementById("prod-preco-kg")?.value) || 0;
      if (pkgVal > 0) precoBase = pkgVal;
    }

    let precoOriginal = null;
    let emPromocao = false;

    if (document.getElementById("prod-promo-ativo")?.checked) {
      const tipo = document.getElementById("prod-promo-tipo")?.value;
      const valor =
        parseFloat(document.getElementById("prod-promo-valor")?.value) || 0;

      if (valor > 0) {
        emPromocao = true;
        precoOriginal = precoBase; // guarda o preço original

        if (tipo === "percent") {
          if (valor >= 100) {
            alert("⚠️ Desconto percentual inválido.");
            return;
          }
          precoBase = Math.round(precoBase * (1 - valor / 100)); // calcula o promocional
        } else {
          // fixo
          precoBase = Math.max(0, precoBase - valor); // subtrai o desconto fixo
        }
      }
    }
    const dados = {
      nome: document.getElementById("prod-nome").value,
      descricao: document.getElementById("prod-desc").value,
      preco: precoBase,
      promo_ativo:
        document.getElementById("prod-promo-ativo")?.checked || false,
      promo_tipo: document.getElementById("prod-promo-tipo")?.value || null,
      promo_valor:
        parseFloat(document.getElementById("prod-promo-valor")?.value) || null,
      em_promocao: emPromocao,
      preco_original: precoOriginal,
      categoria_slug: document.getElementById("prod-cat").value || null,
      subcategoria_slug: document.getElementById("prod-subcat")?.value || null,
      imagem_url: urlFinal,
      e_montavel: false,
      montagem_config: null,
      ativo: true,
      somente_balcao:
        document.getElementById("prod-somente-balcao")?.checked || false,
      // ── Código de barras ──────────────────────────────────
      codigo_barras:
        document.getElementById("prod-codigo-barras")?.value?.trim() || null,
      // ── Varejo ────────────────────────────────────────────
      unidade_venda:
        document.getElementById("prod-unidade-venda")?.value || null,
      destaque: document.getElementById("prod-destaque")?.checked || false,
      // Estoque direto (sem vínculo com inventário) — combos nunca têm
      // estoque próprio, o estoque vem dos componentes.
      estoque_qtd:
        _tipoProdutoVal !== "combo" && document.getElementById("prod-tem-estoque")?.checked
          ? parseInt(document.getElementById("prod-estoque-qtd")?.value) || 0
          : null,
      // ── Combos / fracionamento ─────────────────────────────
      tipo_produto: _tipoProdutoVal,
      fracionavel:
        _tipoProdutoVal !== "combo" &&
        (document.getElementById("prod-fracionavel")?.checked || false),
      unidade_fracionamento:
        _tipoProdutoVal !== "combo" && document.getElementById("prod-fracionavel")?.checked
          ? document.getElementById("prod-unidade-fracionamento")?.value || "un"
          : null,
      // ── Preço de compra / custo ───────────────────────────
      preco_compra: (() => {
        const el = document.getElementById("prod-preco-compra");
        if (!el) return null;
        const raw =
          el.dataset.valorNumerico ||
          (el.value || "").replace(/\D/g, "") ||
          "0";
        const v = parseInt(raw, 10);
        return v > 0 ? v : null;
      })(),
      // ── Perecível ─────────────────────────────────────────
      perecivel: document.getElementById("prod-perecivel")?.checked || false,
      data_validade:
        document.getElementById("prod-perecivel")?.checked &&
        document.getElementById("prod-data-validade")?.value
          ? document.getElementById("prod-data-validade").value
          : null,
    };

    let prodIdSalvo = id ? parseInt(id) : null;

    if (id) {
      const { error: errUpdate } = await supa
        .from("produtos")
        .update(dados)
        .eq("id", parseInt(id));
      if (errUpdate) throw new Error("Erro ao salvar: " + errUpdate.message);
      console.log(
        "[salvarProduto] Produto atualizado. imagem_url:",
        dados.imagem_url,
      );
    } else {
      const { data: novoProd, error: errInsert } = await supa
        .from("produtos")
        .insert([dados])
        .select("id")
        .single();
      if (errInsert) throw errInsert;
      prodIdSalvo = novoProd.id;
    }

    // ── Salva componentes do combo ─────────────────────────────
    if (prodIdSalvo && _tipoProdutoVal === "combo") {
      await comboSalvarComponentes(prodIdSalvo);
    }

    // ── Salva variações de estoque (varejo) ───────────────────
    // ── Salva variações de estoque (varejo) ───────────────────
if (prodIdSalvo && document.getElementById("secao-variacoes-estoque")) {
  await veSalvarVariacoes(prodIdSalvo);

  // === NOVA PARTE: Atualiza montagem_config para o PDV ===
  const { data: variacoes } = await supa
    .from("produto_variacoes")
    .select("id, nome, preco_adicional, preco_absoluto, ativo, ordem")
    .eq("produto_id", prodIdSalvo)
    .order("ordem");

  if (variacoes && variacoes.length > 0) {
    const config = {
      __tipo: "variacoes",
      variacoes: variacoes.map(v => ({
        id: v.id,
        nome: v.nome,
        preco: v.preco_adicional || 0,
        preco_absoluto: v.preco_absoluto || false,
        ativo: v.ativo !== false,
      }))
    };
    await supa
      .from("produtos")
      .update({ montagem_config: config })
      .eq("id", prodIdSalvo);
  }
}
    // ── Fim variações ─────────────────────────────────────────

    fecharModal("modal-produto");
    carregarProdutos();
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    btn.innerText = "Salvar";
    btn.disabled = false;
  }
}

// ── Máscara de preço em Guaranis (sem decimais) ───────────────
function _mascaraGsAdmin(input) {
  // Remove tudo que não for dígito
  let raw = input.value.replace(/\D/g, "");

  // Converte para número e formata com separador de milhar (ponto)
  if (raw === "") {
    input.value = "";
    delete input.dataset.valorNumerico;
    return;
  }

  const num = parseInt(raw, 10);
  // Formato paraguaio: 1.000.000
  input.value = num.toLocaleString("es-PY");

  // Guarda o valor numérico puro num atributo para o salvarProduto ler corretamente
  input.dataset.valorNumerico = String(num);
}

// ── Calcula e exibe o markup no modal de produto ──────────────
// (também definida inline no HTML para garantir disponibilidade imediata)
function _calcularMarkupModal() {
  const elVenda = document.getElementById("prod-preco");
  const elCompra = document.getElementById("prod-preco-compra");
  const elPreview = document.getElementById("prod-markup-preview");
  if (!elVenda || !elCompra || !elPreview) return;

  const venda = parseInt(
    elVenda.dataset.valorNumerico ||
      (elVenda.value || "").replace(/\D/g, "") ||
      "0",
    10,
  );
  const compra = parseInt(
    elCompra.dataset.valorNumerico ||
      (elCompra.value || "").replace(/\D/g, "") ||
      "0",
    10,
  );

  if (!compra || compra <= 0) {
    elPreview.textContent = "";
    return;
  }
  if (!venda || venda <= 0) {
    elPreview.style.color = "#e74c3c";
    elPreview.textContent = "⚠️ Informe o preço de venda";
    return;
  }

  const lucroGs = venda - compra;
  const markupPct = Math.round(((venda - compra) / compra) * 100);
  const margemPct = Math.round(((venda - compra) / venda) * 100);

  if (lucroGs < 0) {
    elPreview.style.color = "#e74c3c";
    elPreview.textContent = `❌ Prejuízo de Gs ${Math.abs(lucroGs).toLocaleString("es-PY")}`;
  } else {
    elPreview.style.color = markupPct >= 30 ? "#16a34a" : "#d97706";
    elPreview.textContent = `📈 Markup ${markupPct}% · Margem ${margemPct}% · +Gs ${lucroGs.toLocaleString("es-PY")}`;
  }
}

async function abrirModalProduto(produto = null, tipoInicial = null) {
  const modal = document.getElementById("modal-produto");

  // Reset completo
  const _bSteps = document.getElementById("builder-steps");
  if (_bSteps) _bSteps.innerHTML = "";
  document.getElementById("prod-id").value = "";
  document.getElementById("prod-nome").value = "";
  document.getElementById("prod-desc").value = "";
  document.getElementById("prod-preco").value = "";
  document.getElementById("prod-img").value = "";
  document.getElementById("box-preview").style.display = "none";
  document.getElementById("prod-somente-balcao").checked = false;
  // ── Preço de compra reset ─────────────────────────────────
  const _pcResetEl = document.getElementById("prod-preco-compra");
  if (_pcResetEl) {
    _pcResetEl.value = "";
    delete _pcResetEl.dataset.valorNumerico;
  }
  const _mkReset = document.getElementById("prod-markup-preview");
  if (_mkReset) _mkReset.textContent = "";
  // ── Código de barras reset ────────────────────────────────
  const _cbResetEl = document.getElementById("prod-codigo-barras");
  if (_cbResetEl) _cbResetEl.value = "";
  // ── Varejo reset ──────────────────────────────────────────
  const _unidEl = document.getElementById("prod-unidade-venda");
  if (_unidEl) _unidEl.value = "";
  const _destEl = document.getElementById("prod-destaque");
  if (_destEl) _destEl.checked = false;
  const _paEl = document.getElementById("prod-promo-ativo");
  if (_paEl) {
    _paEl.checked = false;
    togglePromoFields(false);
  }
  const _pvEl = document.getElementById("prod-promo-valor");
  if (_pvEl) _pvEl.value = "";
  const _ppEl = document.getElementById("prod-promo-preview");
  if (_ppEl) _ppEl.textContent = "";
  // Estoque direto
  const _teResetEl = document.getElementById("prod-tem-estoque");
  if (_teResetEl) {
    _teResetEl.checked = false;
    toggleEstoqueDireto(false);
  }
  const _eqResetEl = document.getElementById("prod-estoque-qtd");
  if (_eqResetEl) _eqResetEl.value = "";
  // ── Combo / Fracionamento reset ────────────────────────────
  const _tipoResetEl = document.getElementById("prod-tipo-produto");
  if (_tipoResetEl) {
    _tipoResetEl.value = "simples";
    toggleTipoProdutoUI("simples");
  }
  const _fracResetEl = document.getElementById("prod-fracionavel");
  if (_fracResetEl) {
    _fracResetEl.checked = false;
    toggleFracionavel(false);
  }
  const _unidFracResetEl = document.getElementById("prod-unidade-fracionamento");
  if (_unidFracResetEl) _unidFracResetEl.value = "ml";
  const _comboListaResetEl = document.getElementById("combo-componentes-lista");
  if (_comboListaResetEl) _comboListaResetEl.innerHTML = "";
  // ── Fim Combo reset ─────────────────────────────────────────
  // Venda por kg
  const _vkResetEl = document.getElementById("prod-venda-kg");
  if (_vkResetEl) {
    _vkResetEl.checked = false;
    toggleVendaKg(false);
  }
  const _pkResetEl = document.getElementById("prod-preco-kg");
  if (_pkResetEl) _pkResetEl.value = "";
  // ── Perecível reset ───────────────────────────────────────
  const _perResetEl = document.getElementById("prod-perecivel");
  if (_perResetEl) {
    _perResetEl.checked = false;
    togglePerecivelFields(false);
  }
  const _dvResetEl = document.getElementById("prod-data-validade");
  if (_dvResetEl) _dvResetEl.value = "";
  // ── Fim Varejo reset ──────────────────────────────────────

  // Limpa file input para não reutilizar imagem anterior
  const fileInputReset = document.getElementById("prod-img-file");
  if (fileInputReset) fileInputReset.value = "";

  if (produto) {
    document.getElementById("prod-id").value = produto.id;
    document.getElementById("prod-nome").value = produto.nome;
    document.getElementById("prod-desc").value = produto.descricao || "";
    const _pvendaEl = document.getElementById("prod-preco");
    if (_pvendaEl) {
      const pv = produto.preco || 0;
      _pvendaEl.value = pv > 0 ? pv.toLocaleString("es-PY") : "";
      _pvendaEl.dataset.valorNumerico = String(pv);
    }
    document.getElementById("prod-img").value = produto.imagem_url || "";
    document.getElementById("prod-somente-balcao").checked =
      produto.somente_balcao || false;

    // ── Preço de compra ────────────────────────────────────
    const _pcEl = document.getElementById("prod-preco-compra");
    if (_pcEl) {
      const pc = produto.preco_compra || 0;
      if (pc > 0) {
        _pcEl.value = pc.toLocaleString("es-PY");
        _pcEl.dataset.valorNumerico = String(pc);
      } else {
        _pcEl.value = "";
        delete _pcEl.dataset.valorNumerico;
      }
    }
    _calcularMarkupModal();

    // ── Código de barras ───────────────────────────────────
    const _cbEl = document.getElementById("prod-codigo-barras");
    if (_cbEl) _cbEl.value = produto.codigo_barras || "";

    // ── Varejo: unidade, destaque, promoção, estoque direto ─
    const _unid = document.getElementById("prod-unidade-venda");
    if (_unid) _unid.value = produto.unidade_venda || "";

    const _dest = document.getElementById("prod-destaque");
    if (_dest) _dest.checked = produto.destaque || false;

    const _promoAtivo = document.getElementById("prod-promo-ativo");
    if (_promoAtivo) {
      _promoAtivo.checked = produto.promo_ativo || false;
      togglePromoFields(produto.promo_ativo || false);
    }
    const _promoTipo = document.getElementById("prod-promo-tipo");
    if (_promoTipo && produto.promo_tipo) _promoTipo.value = produto.promo_tipo;
    const _promoValor = document.getElementById("prod-promo-valor");
    if (_promoValor && produto.promo_valor)
      _promoValor.value = produto.promo_valor;
    promoAtualizarPreview();

    // Estoque direto
    const temEst = produto.estoque_qtd != null;
    const _teEl = document.getElementById("prod-tem-estoque");
    if (_teEl) {
      _teEl.checked = temEst;
      toggleEstoqueDireto(temEst);
    }
    const _eqEl = document.getElementById("prod-estoque-qtd");
    if (_eqEl && temEst) _eqEl.value = produto.estoque_qtd;

    // ── Combo / Fracionamento ────────────────────────────────
    const _tipoProdEl = document.getElementById("prod-tipo-produto");
    const tipoProdVal = produto.tipo_produto === "combo" ? "combo" : "simples";
    if (_tipoProdEl) {
      _tipoProdEl.value = tipoProdVal;
      toggleTipoProdutoUI(tipoProdVal);
    }
    const _fracEl = document.getElementById("prod-fracionavel");
    if (_fracEl) {
      _fracEl.checked = produto.fracionavel || false;
      toggleFracionavel(produto.fracionavel || false);
    }
    const _unidFracEl = document.getElementById("prod-unidade-fracionamento");
    if (_unidFracEl) _unidFracEl.value = produto.unidade_fracionamento || "ml";
    if (tipoProdVal === "combo") {
      await comboCarregarComponentesParaEdicao(produto.id);
    }
    // ── Fim Combo ─────────────────────────────────────────────

    // Venda por Kg
    const eKg = produto.unidade_venda === "kg" && produto.preco_kg > 0;
    const _vkEl = document.getElementById("prod-venda-kg");
    if (_vkEl) {
      _vkEl.checked = eKg;
      toggleVendaKg(eKg);
    }
    const _pkEl = document.getElementById("prod-preco-kg");
    if (_pkEl && produto.preco_kg) _pkEl.value = produto.preco_kg;
    // ── Perecível ──────────────────────────────────────────
    const _perEl = document.getElementById("prod-perecivel");
    if (_perEl) {
      const isPerecivel = produto.perecivel || false;
      _perEl.checked = isPerecivel;
      togglePerecivelFields(isPerecivel);
    }
    const _dvEl = document.getElementById("prod-data-validade");
    if (_dvEl && produto.data_validade)
      _dvEl.value = produto.data_validade.split("T")[0];
    // ── Fim Varejo ──────────────────────────────────────────
    // Inventário vinculado removido — estoque agora é direto no produto
    if (produto.imagem_url) {
      document.getElementById("img-preview").src = produto.imagem_url;
      document.getElementById("box-preview").style.display = "block";
    }
  }

  // CORREÇÃO: Carrega categorias com a categoria atual do produto já selecionada
  const catAtual = produto ? produto.categoria_slug || "" : "";
  const subcatAtual = produto ? produto.subcategoria_slug || "" : "";
  await carregarSelectCategorias(catAtual);
  await carregarSelectSubcategorias(catAtual, subcatAtual);

  // ── Seção de variações de estoque (varejo) ────────────────
  veIniciarSecao(produto ? produto.id : null);
  // ── Fim variações ─────────────────────────────────────────

  modal.style.display = "flex";
}

// Mapa: tipo semântico → qual builder exibir
const BUILDER_MAP = {
  padrao: "",
  bebida: "",
  lanche: "",
  combo: "builder-combo",
  sorvete: "builder-sorvete",
  pizza: "builder-pizza",
  montavel: "builder-montavel",
  acai: "builder-acai",
  shake: "builder-shake",
  suco: "builder-suco",
  variacoes: "builder-variacoes",
  kg: "builder-kg",
  // ── Varejo ──────────────────────────────────────────────
  roupa: "", // usa seção de variações de estoque (veIniciarSecao)
  eletronico: "",
  suplemento: "",
  pod: "",
  mercado: "", // usa unidade_venda + destaque + promo
};
const BUILDER_HINTS = {
  shake: "🥤 Defina tamanhos (P/M/G) e sabores disponíveis.",
};

const _TIPO_BADGE_LABELS = {
  padrao: "📦 Simples",
  bebida: "🥤 Bebida",
  lanche: "🍔 Lanche",
  pizza: "🍕 Pizza",
  acai: "🍇 Açaí",
  shake: "🥤 Shake",
  suco: "🍊 Suco",
  sorvete: "🍦 Sorvete",
  montavel: "🥗 Montável",
  almoco: "🍽️ Prato",
  combo: "⭐ Combo",
  variacoes: "🎨 Multi-variação",
  kg: "⚖️ Venda por Kg",
  // ── Varejo ──────────────────────────────────────────────
  roupa: "👕 Roupa",
  eletronico: "🔌 Eletrônico",
  suplemento: "💪 Suplemento",
  pod: "☁️ Pod / Tabacaria",
  mercado: "🛒 Mercado",
};

function selecionarTipoBuilder(tipo) {
  document.getElementById("prod-tipo-builder").value = tipo;

  document.querySelectorAll(".builder-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tipo === tipo);
  });

  document
    .querySelectorAll(".builder-section")
    .forEach((s) => (s.style.display = "none"));

  const builderId = BUILDER_MAP[tipo];
  if (builderId) {
    const el = document.getElementById(builderId);
    if (el) el.style.display = "block";
  }

  // Para kg: o preço é definido no builder (prod-preco-kg), oculta o campo principal
  const precoBox = document.getElementById("box-prod-preco");
  if (precoBox) precoBox.style.display = tipo === "kg" ? "none" : "";

  // Atualiza badge de tipo no modal
  const badge = document.getElementById("modal-tipo-badge");
  if (badge) badge.textContent = _TIPO_BADGE_LABELS[tipo] || tipo;

  const hintEl = document.getElementById("builder-tipo-hint");
  if (hintEl) {
    const msg = BUILDER_HINTS[tipo] || "";
    hintEl.textContent = msg;
    hintEl.style.display = msg ? "block" : "none";
    if (msg) {
      hintEl.style.cssText =
        "background:#fff8e1;border-left:4px solid #f59e0b;border-radius:6px;padding:10px 14px;font-size:0.82rem;color:#78350f;margin-top:8px;";
    }
  }

  const lancheHint = document.getElementById("builder-lanche-hint");
  if (lancheHint) {
    lancheHint.style.display =
      tipo === "lanche" || tipo === "combo" ? "block" : "none";
  }

  // Para açaí/suco/sorvete: carrega lista de produtos no combo se necessário
  if (tipo === "combo") _carregarComboSelect();

  // ── Varejo: tipos que sempre usam seção de variações ────
  const tiposVarejo = ["roupa", "eletronico", "suplemento", "pod", "variacoes"];
  const secaoVe = document.getElementById("secao-variacoes-estoque");
  if (secaoVe && tiposVarejo.includes(tipo)) {
    // Garante que a seção esteja visível e com dica contextual
    secaoVe.style.display = "";
    const prodId = document.getElementById("prod-id")?.value || null;
    veIniciarSecao(prodId ? parseInt(prodId) : null);
    // Sugestão de variações padrão por tipo
    const sugestoes = {
      roupa: [
        "Branco - P",
        "Branco - M",
        "Branco - G",
        "Preto - P",
        "Preto - M",
        "Preto - G",
      ],
      eletronico: ["110v", "220v", "Bivolt"],
      suplemento: ["Baunilha - 900g", "Chocolate - 900g", "Morango - 900g"],
      pod: ["Melancia", "Menta", "Morango Gelado", "Uva", "Ice"],
    };
    if (sugestoes[tipo] && _ve_variacoes.length === 0) {
      _veMostrarSugestoes(sugestoes[tipo]);
    }
  }
}

// Abre modal com tipo pré-selecionado (vindo do seletor externo)
// Abre o modal de produto em branco (único formulário para todos os tipos)
function criarNovoProduto(tipo) {
  abrirModalProduto(null);
}

// Mantido por compatibilidade — abre o modal diretamente
function toggleNovosProdutosTipos() {
  abrirModalProduto(null);
}

// Removido: toggleAlterarTipo — sem seletor de tipo no modal

// Compatibilidade retroativa
function toggleBuilder() {}

function addBuilderStep(t = "", m = 1, i = []) {
  const div = document.createElement("div");
  div.className = "etapa-item";
  div.innerHTML = `<div class="etapa-header"><input type="text" class="form-control step-titulo" value="${t}" placeholder="Título da etapa (ex: Escolha a base)"><input type="number" class="form-control step-max" value="${m}" style="width:70px" title="Máx. seleções"><button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">X</button></div><textarea class="etapa-ingredientes step-itens" placeholder="Itens separados por vírgula. Ex: Arroz, Atum, Salmão, Tofu">${Array.isArray(i) ? i.join(", ") : i}</textarea>`;
  document.getElementById("builder-steps").appendChild(div);
}

// ─── VARIAÇÕES DE SABOR BUILDER ───────────────────────────────────
function addVariacao(dados = {}) {
  const lista = document.getElementById("variacoes-lista");
  const row = document.createElement("div");
  row.className = "variacao-row";
  const pausado = dados.ativo === false;
  row.style.cssText = `background:${pausado ? "#fff5f5" : "#fff"};border:1px solid ${pausado ? "#fca5a5" : "#e9d5ff"};border-radius:10px;padding:12px;display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;opacity:${pausado ? "0.7" : "1"}`;
  row.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px">
      <input data-f="vnome" class="form-control" value="${dados.nome || ""}" placeholder="Nome da variação (ex: Ex: Variação Premium)" style="font-weight:600">
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:0.8rem;color:#777;white-space:nowrap">Gs</span>
        <input data-f="vpreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="Preço" style="max-width:140px">
      </div>
      <input data-f="vimg" class="form-control" value="${dados.img || ""}" placeholder="URL da foto (opcional — usa foto do produto por padrão)" style="font-size:0.8rem;color:#888">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.82rem;color:${pausado ? "#c0392b" : "#16a34a"}">
        <input data-f="vativo" type="checkbox" ${!pausado ? "checked" : ""} onchange="this.closest('.variacao-row').style.background=this.checked?'#fff':'#fff5f5';this.closest('.variacao-row').style.opacity=this.checked?'1':'0.7';this.closest('.variacao-row').style.borderColor=this.checked?'#e9d5ff':'#fca5a5';this.parentElement.style.color=this.checked?'#16a34a':'#c0392b';this.parentElement.lastChild.textContent=this.checked?' Disponível':' Pausado'">
        <span>${pausado ? " Pausado" : " Disponível"}</span>
      </label>
    </div>
    <div style="width:60px;height:60px;border-radius:8px;overflow:hidden;background:#f3f4f6;flex-shrink:0">
      ${dados.img ? `<img src="${dados.img}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:1.5rem">🖼</div>'}
    </div>
    <button class="btn btn-sm btn-danger" onclick="this.closest('.variacao-row').remove()" title="Remover" style="align-self:start">✕</button>
  `;
  lista.appendChild(row);
}

// ─── PIZZA BUILDER (tipos dinâmicos) ───────────────────────────

function toggleBordaPreco() {
  const tem = document.getElementById("pizza-tem-borda").checked;
  document.getElementById("pizza-borda-preco-box").style.display = tem
    ? "block"
    : "none";
}

// Adiciona um tipo de pizza (ex: Tradicional, Especial, Vegana...)
function addPizzaTipo(nome = "") {
  const lista = document.getElementById("pizza-tipos-lista");
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "pizza-tipo-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;margin-bottom:6px";
  row.innerHTML = `
    <input class="form-control pizza-tipo-nome" value="${nome}" placeholder="Ex: Tradicional, Especial, Vegana"
      oninput="_pizzaRefreshTamanhoPrecos()" style="flex:1">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.pizza-tipo-row').remove();_pizzaRefreshTamanhoPrecos()">✕</button>
  `;
  lista.appendChild(row);
  _pizzaRefreshTamanhoPrecos();
}

// Lê os tipos atuais da lista
function _pizzaTiposAtuais() {
  return [...document.querySelectorAll(".pizza-tipo-nome")]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

// Reconstrói as colunas de preço em todos os tamanhos quando tipos mudam
function _pizzaRefreshTamanhoPrecos() {
  const tipos = _pizzaTiposAtuais();
  document.querySelectorAll(".pizza-tamanho-row").forEach((row) => {
    const box = row.querySelector(".pizza-tamanho-precos-dinamico");
    if (!box) return;
    // Preserva valores existentes
    const valoresExistentes = {};
    box.querySelectorAll('[data-f="preco_tipo"]').forEach((inp) => {
      if (inp.dataset.tipo) valoresExistentes[inp.dataset.tipo] = inp.value;
    });
    box.innerHTML = tipos
      .map(
        (t) => `
      <div>
        <label style="font-size:0.72rem;color:#555">💰 ${t} (Gs)</label>
        <input data-f="preco_tipo" data-tipo="${t}" type="number" class="form-control"
          value="${valoresExistentes[t] || ""}" placeholder="0" min="0" step="500">
      </div>`,
      )
      .join("");
  });
  // Atualiza select de tipo nos sabores
  document.querySelectorAll(".pizza-sabor-tipo").forEach((sel) => {
    const val = sel.value;
    sel.innerHTML =
      tipos
        .map(
          (t) =>
            `<option value="${t}" ${t === val ? "selected" : ""}>${t}</option>`,
        )
        .join("") || '<option value="">— Tipo —</option>';
  });
}

function addPizzaBorda(dados = {}) {
  const lista = document.getElementById("pizza-bordas-lista");
  const row = document.createElement("div");
  row.className = "pizza-borda-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 10px;margin-bottom:6px";
  row.innerHTML = `
    <div style="flex:3">
      <label style="font-size:0.72rem;color:#888">Nome da borda</label>
      <input data-f="bnome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Cheddar, Catupiry, Chocolate">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Preço (Gs)</label>
      <input data-f="bpreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500">
    </div>
    <button class="btn btn-sm btn-danger" onclick="this.closest('.pizza-borda-row').remove()" style="align-self:flex-end;margin-bottom:2px">✕</button>
  `;
  lista.appendChild(row);
}

function addPizzaTamanho(dados = {}) {
  const lista = document.getElementById("pizza-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "pizza-tamanho-row";
  const tipos = _pizzaTiposAtuais();

  // Preços existentes: novo formato (precos obj) ou antigo (preco_tradicional etc.)
  const precosExist = dados.precos || {
    Tradicional: dados.preco_tradicional || dados.preco || "",
    Especial: dados.preco_especial || "",
    Doce: dados.preco_doce || "",
  };

  row.innerHTML = `
    <div class="pizza-tamanho-header" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px">
      <div style="flex:2;min-width:80px"><label style="font-size:0.72rem;color:#555">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: P, M, G, GG"></div>
      <div style="flex:1;min-width:60px"><label style="font-size:0.72rem;color:#555">Fatias</label><input data-f="fatias" type="number" class="form-control" value="${dados.fatias || ""}" placeholder="8"></div>
      <div style="flex:1;min-width:60px"><label style="font-size:0.72rem;color:#555">Cm</label><input data-f="cm" type="number" class="form-control" value="${dados.cm || ""}" placeholder="35"></div>
      <div style="flex:1;min-width:70px"><label style="font-size:0.72rem;color:#555">Máx. sabores</label><input data-f="max_sabores" type="number" min="1" max="8" class="form-control" value="${dados.max_sabores || 2}"></div>
      <button class="btn btn-sm btn-danger" onclick="this.closest('.pizza-tamanho-row').remove()" style="margin-bottom:2px">✕</button>
    </div>
    <div class="pizza-tamanho-precos-dinamico" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px">
      ${tipos
        .map(
          (t) => `
        <div>
          <label style="font-size:0.72rem;color:#555">💰 ${t} (Gs)</label>
          <input data-f="preco_tipo" data-tipo="${t}" type="number" class="form-control"
            value="${precosExist[t] || ""}" placeholder="0" min="0" step="500">
        </div>`,
        )
        .join("")}
    </div>
  `;
  lista.appendChild(row);
}

function addPizzaSabor(dados = {}) {
  const lista = document.getElementById("pizza-sabores-lista");
  const ph = lista.querySelector("p");
  if (ph) ph.remove();
  const tipos = _pizzaTiposAtuais();
  const row = document.createElement("div");
  row.className = "pizza-sabor-row";
  row.draggable = true;
  const imgSrc = dados.img || "";
  const isAtivo = dados.ativo !== false; // default true
  row.innerHTML = `
    <div class="pizza-sabor-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      <span class="drag-handle" title="Arrastar para reordenar"
        style="cursor:grab;font-size:1.1rem;color:#aaa;padding:0 4px;user-select:none">⠿</span>
      <input data-f="snome" class="form-control" value="${dados.nome || ""}" placeholder="Nome do sabor" style="flex:2;min-width:120px">
      <select data-f="stipo" class="form-control pizza-sabor-tipo" style="flex:1;min-width:100px">
        ${
          tipos.length
            ? tipos
                .map(
                  (t) =>
                    `<option value="${t}" ${dados.tipo === t ? "selected" : ""}>${t}</option>`,
                )
                .join("")
            : `<option value="${dados.tipo || ""}">${dados.tipo || "—"}</option>`
        }
      </select>
      <button type="button" class="btn btn-sm pizza-sabor-toggle-ativo"
        data-ativo="${isAtivo}"
        style="background:${isAtivo ? "#27ae60" : "#e74c3c"};color:#fff;border:none;
               border-radius:6px;padding:4px 9px;cursor:pointer;font-size:0.78rem;white-space:nowrap"
        onclick="pizzaSaborToggleAtivo(this)">
        ${isAtivo ? "✅ Ativo" : "⏸ Pausado"}
      </button>
      <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.pizza-sabor-row').remove()">✕</button>
    </div>
    <textarea data-f="sdesc" class="form-control" rows="1" placeholder="Descrição (opcional)" style="margin-bottom:6px">${dados.desc || ""}</textarea>
    <div style="display:flex;gap:8px;align-items:center">
      ${imgSrc ? `<img src="${imgSrc}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0">` : ""}
      <input data-f="simg" type="text" class="form-control" value="${imgSrc}" placeholder="URL da imagem (opcional)" style="flex:1;font-size:0.8rem">
      <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem;white-space:nowrap">
        📷 <input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this, this.closest('.pizza-sabor-row'))">
      </label>
    </div>
  `;
  _pizzaSaborDragBind(row);
  lista.appendChild(row);
}

function pizzaSaborToggleAtivo(btn) {
  const atual = btn.dataset.ativo === "true";
  const novo = !atual;
  btn.dataset.ativo = String(novo);
  btn.style.background = novo ? "#27ae60" : "#e74c3c";
  btn.textContent = novo ? "✅ Ativo" : "⏸ Pausado";
}

// ── Drag & Drop nativo para reordenar sabores ──────────────────
let _dragSaborRow = null;

function _pizzaSaborDragBind(row) {
  row.addEventListener("dragstart", (e) => {
    _dragSaborRow = row;
    row.style.opacity = "0.4";
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    row.style.opacity = "";
    _dragSaborRow = null;
    // Remove indicadores visuais
    document
      .querySelectorAll(".pizza-sabor-row")
      .forEach((r) => r.classList.remove("drag-over"));
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (_dragSaborRow && _dragSaborRow !== row) {
      row.classList.add("drag-over");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drag-over");
    if (!_dragSaborRow || _dragSaborRow === row) return;
    const lista = document.getElementById("pizza-sabores-lista");
    const rows = [...lista.querySelectorAll(".pizza-sabor-row")];
    const fromIdx = rows.indexOf(_dragSaborRow);
    const toIdx = rows.indexOf(row);
    if (fromIdx < toIdx) {
      lista.insertBefore(_dragSaborRow, row.nextSibling);
    } else {
      lista.insertBefore(_dragSaborRow, row);
    }
  });
}

// Inicializa drag em sabores existentes (chamado ao abrir modal de edição)
function _pizzaSaboresDragInit() {
  document
    .querySelectorAll("#pizza-sabores-lista .pizza-sabor-row")
    .forEach(_pizzaSaborDragBind);
}

async function uploadSaborImagem(fileInput, row) {
  if (!fileInput.files.length) return;
  const file = fileInput.files[0];
  fileInput.disabled = true;

  // Feedback visual no botão/label pai
  const labelBtn = fileInput.closest("label");
  const originalLabel = labelBtn ? labelBtn.innerHTML : null;
  if (labelBtn) labelBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    // ── Upload para o Cloudinary (substitui Supabase Storage) ──
    const url = await uploadImageToImgbb(file);

    const inp =
      row.querySelector('[data-f="simg"]') ||
      row.querySelector('[data-f="img"]');
    if (inp) inp.value = url;
    const prev = row.querySelector("img.img-preview-mini");
    if (prev) {
      prev.src = url;
      prev.style.display = "block";
    }
  } catch (e) {
    alert("Erro ao enviar imagem: " + e.message);
  } finally {
    fileInput.disabled = false;
    if (labelBtn && originalLabel) labelBtn.innerHTML = originalLabel;
  }
}

// ─── AÇAÍ BUILDER ────────────────────────────────────────────────

function addAcaiTamanho(dados = {}) {
  const lista = document.getElementById("acai-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "acai-tamanho-row builder-item-row";
  const img = dados.img || "";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: 300ml, Médio, G"></div>
      <div><label class="bir-label">Preço (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500"></div>
      <div style="position:relative">
        <label class="bir-label">Imagem</label>
        <div style="display:flex;gap:4px">
          <input data-f="img" type="text" class="form-control" value="${img}" placeholder="URL ou 📷">
          <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem;white-space:nowrap">
            📷<input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this,this.closest('.acai-tamanho-row'))">
          </label>
        </div>
        ${img ? `<img class="img-preview-mini" src="${img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">` : '<img class="img-preview-mini" style="display:none;width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">'}
      </div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.acai-tamanho-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addAcaiAcompanhamento(dados = {}) {
  const lista = document.getElementById("acai-acomp-lista");
  const row = document.createElement("div");
  row.className = "acai-acomp-row builder-item-row";
  const img = dados.img || "";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Granola, Leite Condensado"></div>
      <div><label class="bir-label">Preço extra (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="0 = incluído" min="0" step="100"></div>
      <div>
        <label class="bir-label">Imagem</label>
        <div style="display:flex;gap:4px">
          <input data-f="img" type="text" class="form-control" value="${img}" placeholder="URL ou 📷">
          <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem;white-space:nowrap">
            📷<input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this,this.closest('.acai-acomp-row'))">
          </label>
        </div>
        ${img ? `<img class="img-preview-mini" src="${img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">` : '<img class="img-preview-mini" style="display:none;width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">'}
      </div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.acai-acomp-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addAcaiEtapa(titulo = "", max = 1, itens = []) {
  const container = document.getElementById("acai-etapas-container");
  const div = document.createElement("div");
  div.className = "etapa-item";
  const itensStr = Array.isArray(itens) ? itens.join(", ") : itens;
  div.innerHTML = `
    <div class="etapa-header">
      <input type="text" class="form-control step-titulo" value="${titulo}" placeholder="Título da etapa (ex: Frutas)">
      <input type="number" class="form-control step-max" value="${max}" style="width:70px" title="Máx. seleções">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <textarea class="etapa-ingredientes step-itens" placeholder="Itens separados por vírgula. Ex: Morango, Banana, Uva">${itensStr}</textarea>`;
  container.appendChild(div);
}

// ─── SUCO BUILDER ────────────────────────────────────────────────

function addSucoTamanho(dados = {}) {
  const lista = document.getElementById("suco-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "suco-tamanho-row builder-item-row";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: 300ml, 500ml, Grande"></div>
      <div><label class="bir-label">Preço (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500"></div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.suco-tamanho-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addSucoEtapa(titulo = "", max = 1, itens = []) {
  const container = document.getElementById("suco-etapas-container");
  const div = document.createElement("div");
  div.className = "etapa-item";
  const itensStr = Array.isArray(itens) ? itens.join(", ") : itens;
  div.innerHTML = `
    <div class="etapa-header">
      <input type="text" class="form-control step-titulo" value="${titulo}" placeholder="Título da etapa (ex: Fruta principal)">
      <input type="number" class="form-control step-max" value="${max}" style="width:70px" title="Máx. seleções">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <textarea class="etapa-ingredientes step-itens" placeholder="Ex: Laranja, Limão, Maracujá">${itensStr}</textarea>`;
  container.appendChild(div);
}

// ─── SORVETE BUILDER ─────────────────────────────────────────────

function addSorveteTamanho(dados = {}) {
  const lista = document.getElementById("sorvete-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "sorvete-tamanho-row builder-item-row";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: 1 Bola, Duplo, 3 Bolas"></div>
      <div><label class="bir-label">Qtd. Bolas</label><input data-f="qtd_bolas" type="number" class="form-control" value="${dados.qtd_bolas || ""}" placeholder="1" min="1"></div>
      <div><label class="bir-label">Preço (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500"></div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.sorvete-tamanho-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addSorveteSabor(dados = {}) {
  const lista = document.getElementById("sorvete-sabores-lista");
  const row = document.createElement("div");
  row.className = "sorvete-sabor-row builder-item-row";
  const img = dados.img || "";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Sabor</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Chocolate, Morango, Baunilha"></div>
      <div><label class="bir-label">Preço extra (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="0 = incluído" min="0" step="100"></div>
      <div>
        <label class="bir-label">Imagem</label>
        <div style="display:flex;gap:4px">
          <input data-f="img" type="text" class="form-control" value="${img}" placeholder="URL ou 📷">
          <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem">
            📷<input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this,this.closest('.sorvete-sabor-row'))">
          </label>
        </div>
        ${img ? `<img class="img-preview-mini" src="${img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">` : '<img class="img-preview-mini" style="display:none;width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">'}
      </div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.sorvete-sabor-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addSorveteEtapa(titulo = "", max = 1, itens = []) {
  const container = document.getElementById("sorvete-etapas-container");
  const div = document.createElement("div");
  div.className = "etapa-item";
  const itensStr = Array.isArray(itens) ? itens.join(", ") : itens;
  div.innerHTML = `
    <div class="etapa-header">
      <input type="text" class="form-control step-titulo" value="${titulo}" placeholder="Título da etapa (ex: Cobertura)">
      <input type="number" class="form-control step-max" value="${max}" style="width:70px" title="Máx. seleções">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <textarea class="etapa-ingredientes step-itens" placeholder="Ex: Calda de Chocolate, Caramelo, Granulado">${itensStr}</textarea>`;
  container.appendChild(div);
}

// ─── VARIAÇÃO SIMPLES (para açaí / sorvete) ──────────────────────
// Igual a addVariacao mas sem foto, para listas secundárias
function addVariacaoSimples(dados = {}, listaId) {
  const lista = document.getElementById(listaId);
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "variacao-acai-row builder-item-row";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="vnome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Tradicional, Premium"></div>
      <div><label class="bir-label">Preço extra (Gs)</label><input data-f="vpreco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="0" min="0" step="100"></div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.variacao-acai-row').remove()">✕</button>`;
  lista.appendChild(row);
}

// ─── COMBO BUILDER ───────────────────────────────────────────────

async function _carregarComboSelect() {
  const container = document.getElementById("combo-produtos-selecionados");
  if (!container) return;
  container.innerHTML =
    '<div style="text-align:center;padding:10px;color:#aaa;font-size:0.82rem">Carregando produtos...</div>';
  const { data } = await supa
    .from("produtos")
    .select("id, nome, preco, categoria_slug")
    .eq("ativo", true)
    .order("nome");
  if (!data || !data.length) {
    container.innerHTML =
      '<div style="color:#aaa;font-size:0.82rem">Nenhum produto cadastrado.</div>';
    return;
  }
  const presel = window._comboItensPresel || [];
  container.innerHTML = data
    .map(
      (p) => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;border:1px solid ${presel.includes(p.id) ? "#1a7a2e" : "#eee"};background:${presel.includes(p.id) ? "#f0fff4" : "#fff"};margin-bottom:4px;transition:all 0.15s"
      onmousedown="this.style.borderColor='#1a7a2e';this.style.background='#f0fff4'">
      <input type="checkbox" value="${p.id}" ${presel.includes(p.id) ? "checked" : ""} style="width:16px;height:16px"
        onchange="this.closest('label').style.borderColor=this.checked?'#1a7a2e':'#eee';this.closest('label').style.background=this.checked?'#f0fff4':'#fff'">
      <span style="flex:1;font-size:0.87rem;font-weight:600">${p.nome}</span>
      <span style="font-size:0.78rem;color:#888">${p.categoria_slug || ""}</span>
      <span style="font-size:0.8rem;color:#27ae60;font-weight:700;white-space:nowrap">Gs ${(p.preco || 0).toLocaleString("es-PY")}</span>
    </label>`,
    )
    .join("");
}

// ─── DUPLICAR PRODUTO ────────────────────────────────────────────

async function duplicarProduto(id) {
  if (
    !confirm(
      'Duplicar este produto? Uma cópia será criada com o nome "(Cópia) ..."',
    )
  )
    return;
  const { data: p, error } = await supa
    .from("produtos")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !p) {
    alert("Erro ao buscar produto.");
    return;
  }
  const copia = { ...p };
  delete copia.id;
  delete copia.created_at;
  delete copia.updated_at;
  copia.nome = `(Cópia) ${p.nome}`;
  copia.ativo = false; // entra como pausado para revisão
  const { error: errIns } = await supa.from("produtos").insert([copia]);
  if (errIns) {
    alert("Erro ao duplicar: " + errIns.message);
    return;
  }
  alert(t("alert.produto_duplicado"));
  carregarProdutos();
}

function toggleExtras() {
  const ativo = document.getElementById("prod-tem-extras").checked;
  document.getElementById("extras-area").style.display = ativo
    ? "block"
    : "none";
}

function addExtra(dados = {}) {
  const lista = document.getElementById("extras-lista");
  const row = document.createElement("div");
  row.className = "extra-row";
  row.innerHTML = `
    <input data-f="enome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Wasabi, Ovo Frito">
    <input data-f="epreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="Preço (Gs)">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.extra-row').remove()" title="Remover">✕</button>
  `;
  lista.appendChild(row);
}

// ── PREPARO ──────────────────────────────────
function togglePreparo() {
  const ativo = document.getElementById("prod-tem-preparo").checked;
  document.getElementById("preparo-area").style.display = ativo
    ? "block"
    : "none";
}

function addOpcaoPreparo(valor = "") {
  const lista = document.getElementById("preparo-lista");
  const row = document.createElement("div");
  row.className = "extra-row preparo-row-admin";
  row.innerHTML = `
    <input class="form-control preparo-opcao-input" value="${valor}" placeholder="Ex: Salmão Flambado, Batata Frita">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.preparo-row-admin').remove()" title="Remover">✕</button>
  `;
  lista.appendChild(row);
}

// ── ADICIONAIS GLOBAIS ────────────────────────
function addExtraGlobal(dados = {}) {
  const lista = document.getElementById("extras-globais-lista");
  const row = document.createElement("div");
  row.className = "extra-row";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <input data-f="gnome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Ex: Adicional Extra">
    <input data-f="gpreco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="Preço (0 = Grátis)">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.extra-row').remove()" title="Remover">✕</button>
  `;
  lista.appendChild(row);
}

async function salvarExtrasGlobais() {
  const extras = [];
  document
    .querySelectorAll("#extras-globais-lista .extra-row")
    .forEach((row) => {
      const nome = row.querySelector('[data-f="gnome"]').value.trim();
      const preco =
        parseFloat(row.querySelector('[data-f="gpreco"]').value) || 0;
      if (nome) extras.push({ nome, preco });
    });

  // Categorias selecionadas (null = todas)
  const catChips = document.querySelectorAll(
    '#extras-globais-cats-lista input[type="checkbox"]:checked',
  );
  const catsArr = [...catChips].map((c) => c.value);
  const catsVal = catsArr.length === 0 ? null : catsArr;

  const { error } = await supa
    .from("configuracoes")
    .update({
      extras_globais: extras,
      extras_globais_categorias: catsVal,
    })
    .gt("id", 0);
  if (error) {
    alert("Erro ao salvar adicionais globais: " + error.message);
    return;
  }
  alert("✅ Adicionais globais salvos!");
}

async function carregarExtrasGlobaisAdmin() {
  const lista = document.getElementById("extras-globais-lista");
  if (!lista) return;
  lista.innerHTML = "";
  try {
    const { data, error } = await supa
      .from("configuracoes")
      .select("extras_globais, extras_globais_categorias")
      .single();
    if (error) {
      console.warn("Extras globais:", error.message);
      return;
    }
    if (data?.extras_globais && Array.isArray(data.extras_globais))
      data.extras_globais.forEach((ex) => addExtraGlobal(ex));

    // Carrega categorias para o seletor
    const { data: cats } = await supa
      .from("categorias")
      .select("slug, nome_exibicao")
      .eq("ativa", true)
      .order("ordem");
    const catsContainer = document.getElementById("extras-globais-cats-lista");
    if (catsContainer && cats) {
      const selCats = data?.extras_globais_categorias || null;
      catsContainer.innerHTML = cats
        .map(
          (c) => `
        <label style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--color-background-secondary);border-radius:6px;cursor:pointer;font-size:0.82rem">
          <input type="checkbox" value="${c.slug}" ${!selCats || selCats.includes(c.slug) ? "checked" : ""} style="width:15px;height:15px">
          ${c.nome_exibicao || c.slug}
        </label>`,
        )
        .join("");
    }
  } catch (e) {
    console.log("Extras globais:", e.message);
  }
}

// =========================================
// AVISAR ENCERRAMENTO DO DELIVERY
// =========================================

/**
 * Grava na tabela `configuracoes` um timestamp de encerramento
 * e um aviso visível para todos os clientes.
 *
 * Na tabela configuracoes precisam existir os campos:
 *   aviso_delivery  TEXT  (mensagem exibida no banner do site)
 *   delivery_aberto BOOLEAN (controla se o delivery está habilitado)
 */
async function avisarEncerramentoDelivery() {
  const modal = document.getElementById("modal-encerramento-delivery");
  if (modal) {
    modal.style.display = "flex";
    return;
  }

  // Cria o modal dinamicamente se não estiver no HTML
  const overlay = document.createElement("div");
  overlay.id = "modal-encerramento-delivery";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <h3 style="margin:0;font-size:1.1rem;color:#c0392b">🚫 Encerrar Delivery</h3>
        <button onclick="this.closest('#modal-encerramento-delivery').remove()" 
                style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#999">✕</button>
      </div>

      <p style="color:#555;font-size:0.9rem;margin-bottom:16px">
        Isso vai <strong>fechar o delivery imediatamente</strong> e exibir um aviso para os clientes no site.
      </p>

      <label style="font-weight:600;font-size:0.85rem;color:#333;display:block;margin-bottom:6px">
        Mensagem para os clientes (opcional):
      </label>
      <textarea id="aviso-encerramento-texto" rows="3"
        style="width:100%;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.9rem;resize:vertical;box-sizing:border-box;margin-bottom:16px"
        placeholder="Ex: Delivery encerrado por hoje. Voltamos amanhã às 18h! 🍣"></textarea>

      <div style="display:flex;gap:10px">
        <button onclick="this.closest('#modal-encerramento-delivery').remove()"
                style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-weight:600;cursor:pointer">
          Cancelar
        </button>
        <button onclick="_confirmarEncerramentoDelivery()"
                style="flex:1;padding:12px;background:#e74c3c;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer">
          🚫 Fechar Agora
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}

async function _confirmarEncerramentoDelivery() {
  const texto =
    document.getElementById("aviso-encerramento-texto")?.value?.trim() ||
    "Delivery encerrado por hoje. Obrigado! 🍣";

  const { error } = await supa
    .from("configuracoes")
    .update({
      delivery_aberto: false,
      aviso_delivery: texto,
    })
    .gt("id", 0);

  if (error) {
    // Tenta com upsert se update falhou (configuracoes pode não ter a linha)
    const { error: e2 } = await supa.from("configuracoes").upsert({
      id: 1,
      delivery_aberto: false,
      aviso_delivery: texto,
    });
    if (e2) {
      alert(
        "Erro ao encerrar delivery: " +
          e2.message +
          "\n\n💡 Execute no Supabase:\nALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS delivery_aberto BOOLEAN DEFAULT true;\nALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS aviso_delivery TEXT DEFAULT '';",
      );
      return;
    }
  }

  document.getElementById("modal-encerramento-delivery")?.remove();
  alert(t("alert.delivery_encerrado"));

  // Atualiza badge no painel se existir
  const badge = document.getElementById("badge-delivery-status");
  if (badge) {
    badge.style.background = "#e74c3c";
    badge.textContent = "🔴 Delivery Fechado";
  }
}

async function reabrirDelivery() {
  if (!confirm("Reabrir o delivery para novos pedidos?")) return;

  const { error } = await supa
    .from("configuracoes")
    .update({
      delivery_aberto: true,
      aviso_delivery: "",
    })
    .gt("id", 0);

  if (error) {
    alert("Erro: " + error.message);
    return;
  }

  alert(t("alert.delivery_reaberto"));

  const badge = document.getElementById("badge-delivery-status");
  if (badge) {
    badge.style.background = "#27ae60";
    badge.textContent = "🟢 Delivery Aberto";
  }
}

// =========================================
// ESTENDER HORÁRIO DE FUNCIONAMENTO
// =========================================

/**
 * Abre um modal para adicionar minutos extras ao horário de hoje.
 * Grava em configuracoes.horario_extra_hoje = { data: 'YYYY-MM-DD', minutos: N }
 * O app.js deve ler este campo para calcular o horário real de fechamento.
 *
 * Execute no Supabase:
 *   ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS horario_extra_hoje JSONB DEFAULT NULL;
 */
function abrirModalEstenderHorario() {
  const existente = document.getElementById("modal-estender-horario");
  if (existente) {
    existente.style.display = "flex";
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "modal-estender-horario";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <h3 style="margin:0;font-size:1.1rem;color:#2980b9">⏰ Estender Horário Hoje</h3>
        <button onclick="this.closest('#modal-estender-horario').remove()"
                style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#999">✕</button>
      </div>

      <p style="color:#555;font-size:0.88rem;margin-bottom:18px">
        Adicione minutos extras ao horário de hoje. O site aceitará pedidos por mais tempo.
      </p>

      <label style="font-weight:600;font-size:0.85rem;color:#333;display:block;margin-bottom:10px">
        Quantos minutos a mais?
      </label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
        ${[15, 30, 45, 60, 90, 120]
          .map(
            (m) => `
          <button onclick="_selecionarMinutosExtra(${m}, this)"
                  data-min="${m}"
                  style="padding:10px 16px;border:2px solid #e0e0e0;border-radius:8px;background:#f8f9fa;font-weight:700;cursor:pointer;font-size:0.9rem;transition:all 0.15s">
            +${m}min
          </button>`,
          )
          .join("")}
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <label style="font-size:0.85rem;color:#666;white-space:nowrap">Ou digite:</label>
        <input type="number" id="input-minutos-extra" min="1" max="480" placeholder="ex: 45"
               oninput="document.querySelectorAll('[data-min]').forEach(b => b.style.background='#f8f9fa')"
               style="flex:1;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.95rem;font-weight:700">
        <span style="color:#666;font-size:0.85rem">min</span>
      </div>

      <div style="display:flex;gap:10px">
        <button onclick="this.closest('#modal-estender-horario').remove()"
                style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-weight:600;cursor:pointer">
          Cancelar
        </button>
        <button onclick="_confirmarEstenderHorario()"
                style="flex:1;padding:12px;background:#2980b9;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer">
          ⏰ Confirmar
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}

function _selecionarMinutosExtra(min, btn) {
  // Destaca o botão selecionado e limpa o input
  document.querySelectorAll("[data-min]").forEach((b) => {
    b.style.background = "#f8f9fa";
    b.style.borderColor = "#e0e0e0";
    b.style.color = "#333";
  });
  btn.style.background = "#2980b9";
  btn.style.borderColor = "#2980b9";
  btn.style.color = "#fff";
  const inp = document.getElementById("input-minutos-extra");
  if (inp) inp.value = min;
}

async function _confirmarEstenderHorario() {
  const inp = document.getElementById("input-minutos-extra");
  const minutos = parseInt(inp?.value || "0");
  if (!minutos || minutos < 1) {
    alert("Escolha quantos minutos deseja adicionar.");
    return;
  }

  const hoje = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const { error } = await supa
    .from("configuracoes")
    .update({
      horario_extra_hoje: { data: hoje, minutos },
    })
    .gt("id", 0);

  if (error) {
    const { error: e2 } = await supa.from("configuracoes").upsert({
      id: 1,
      horario_extra_hoje: { data: hoje, minutos },
    });
    if (e2) {
      alert(
        "Erro ao salvar: " +
          e2.message +
          "\n\n💡 Execute no Supabase:\nALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS horario_extra_hoje JSONB DEFAULT NULL;",
      );
      return;
    }
  }

  document.getElementById("modal-estender-horario")?.remove();
  alert(`✅ Horário estendido em +${minutos} minutos hoje!`);
}

async function removerExtensaoHorario() {
  if (!confirm("Remover a extensão de horário de hoje?")) return;
  await supa
    .from("configuracoes")
    .update({ horario_extra_hoje: null })
    .gt("id", 0);
  alert("✅ Extensão removida.");
}

// Carrega status do delivery no painel (chamado no DOMContentLoaded / showTab)
async function carregarStatusDelivery() {
  const badge = document.getElementById("badge-delivery-status");
  if (!badge) return;
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("delivery_aberto, aviso_delivery, horario_extra_hoje")
      .gt("id", 0)
      .single();

    if (!data) return;

    if (data.delivery_aberto === false) {
      badge.style.background = "#e74c3c";
      badge.textContent = "🔴 Delivery Fechado";
    } else {
      badge.style.background = "#27ae60";
      badge.textContent = "🟢 Delivery Aberto";
    }

    // Mostra extensão de horário se ativa hoje
    const hoje = new Date().toISOString().split("T")[0];
    const ext = data.horario_extra_hoje;
    const badgeExt = document.getElementById("badge-horario-extra");
    if (badgeExt) {
      if (ext && ext.data === hoje && ext.minutos > 0) {
        badgeExt.style.display = "inline-block";
        badgeExt.textContent = `⏰ +${ext.minutos}min hoje`;
      } else {
        badgeExt.style.display = "none";
      }
    }
  } catch (e) {
    // Colunas ainda não existem — ignora silenciosamente
  }
}

// --- CATEGORIAS ---
async function carregarCategorias() {
  const { data, error } = await supa
    .from("categorias")
    .select("*")
    .order("ordem");

  const grid = document.getElementById("lista-categorias");
  if (!grid) return;

  if (error) {
    grid.innerHTML = `<p style="color:red;padding:20px">Erro ao carregar categorias: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    grid.innerHTML = `
      <div class="cat-empty">
        <i class="fas fa-tags" style="font-size:3rem;color:#ddd;margin-bottom:12px;display:block"></i>
        <p>Nenhuma categoria criada ainda.</p>
        <button class="btn btn-primary" onclick="abrirModalCategoria()"><i class="fas fa-plus"></i> Criar primeira categoria</button>
      </div>`;
    carregarSelectCategorias();
    return;
  }

  const paleta = [
    "#FF441F",
    "#3498db",
    "#2ecc71",
    "#9b59b6",
    "#e67e22",
    "#1abc9c",
    "#e74c3c",
    "#f39c12",
    "#34495e",
    "#00b894",
  ];

  grid.innerHTML = "";
  data.forEach((c, idx) => {
    const cor = paleta[idx % paleta.length];
    const cJson = JSON.stringify(c)
      .replace(/'/g, "&apos;")
      .replace(/"/g, "&quot;");
    const horarioBadge =
      c.hora_inicio && c.hora_fim
        ? `<span class="cat-badge cat-badge-horario">🕐 ${c.hora_inicio}–${c.hora_fim}${Array.isArray(c.dias_semana) && c.dias_semana.length ? " (" + c.dias_semana.join(",") + ")" : ""}</span>`
        : `<span class="cat-badge cat-badge-sempre">✅ Sempre visível</span>`;

    const card = document.createElement("div");
    card.className = "cat-card";
    card.style.borderTopColor = cor;
    card.setAttribute("draggable", "true");
    card.setAttribute("data-cat-slug", c.slug);
    card.setAttribute("data-cat-ordem", c.ordem);
    card.innerHTML = `
      <div class="cat-card-top">
        <div class="cat-drag-handle" title="Arraste para reordenar" style="cursor:grab; padding:0 8px 0 2px; color:#bbb; font-size:1.2rem; display:flex; align-items:center; user-select:none;">
          ⠿
        </div>
        <div class="cat-card-icon" style="background:${cor}20;color:${cor}">
          <i class="fas fa-tag"></i>
        </div>
        <div class="cat-card-info">
          <div class="cat-card-nome">${c.nome_exibicao}</div>
          <code class="cat-card-slug">${c.slug}</code>
        </div>
        <div class="cat-card-ordem" style="background:${cor}15;color:${cor}">#${c.ordem}</div>
      </div>
      <div class="cat-card-mid">${horarioBadge}</div>
      <div class="cat-card-actions">
        <button class="cat-btn cat-btn-sub" onclick="abrirPainelSubcategorias('${c.slug}')" title="Gerenciar Subcategorias">
          <i class="fas fa-layer-group"></i><span>Sub</span>
        </button>
        <button class="cat-btn cat-btn-edit" onclick='editarCategoria(${cJson})' title="Editar Categoria">
          <i class="fas fa-pen"></i><span>Editar</span>
        </button>
        <button class="cat-btn cat-btn-del" onclick="deletarCat('${c.slug}')" title="Excluir Categoria">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  // Inicializa drag & drop após renderizar
  iniciarDragDropCategorias(grid);

  carregarSelectCategorias();
}

// =========================================
// DRAG & DROP — REORDENAR CATEGORIAS
// =========================================
function iniciarDragDropCategorias(grid) {
  let draggingEl = null;
  let placeholder = null;

  // Cria o placeholder visual
  function criarPlaceholder() {
    const ph = document.createElement("div");
    ph.id = "cat-drag-placeholder";
    ph.style.cssText = `
      border: 2px dashed #FF441F;
      border-radius: 12px;
      background: rgba(255,68,31,0.05);
      min-height: 80px;
      transition: all 0.15s ease;
      opacity: 0.7;
    `;
    return ph;
  }

  grid.querySelectorAll(".cat-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggingEl = card;
      placeholder = criarPlaceholder();
      // Visual do card sendo arrastado
      setTimeout(() => {
        card.style.opacity = "0.4";
        card.style.transform = "scale(0.97)";
      }, 0);
      e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", async () => {
      if (draggingEl) {
        draggingEl.style.opacity = "1";
        draggingEl.style.transform = "";
      }
      if (placeholder && placeholder.parentNode) placeholder.remove();
      draggingEl = null;
      placeholder = null;

      // Salva nova ordem no banco
      await salvarOrdemCategorias(grid);
    });

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!draggingEl || draggingEl === card) return;

      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (placeholder.parentNode) placeholder.remove();

      if (e.clientY < midY) {
        grid.insertBefore(placeholder, card);
      } else {
        grid.insertBefore(placeholder, card.nextSibling);
      }
    });

    card.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggingEl || draggingEl === card) return;
      if (placeholder && placeholder.parentNode) {
        grid.insertBefore(draggingEl, placeholder);
        placeholder.remove();
      }
    });
  });

  // Permite soltar no próprio grid (área vazia)
  grid.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  grid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (draggingEl && placeholder?.parentNode) {
      grid.insertBefore(draggingEl, placeholder);
      placeholder.remove();
    }
  });
}

async function salvarOrdemCategorias(grid) {
  const cards = grid.querySelectorAll(".cat-card[data-cat-slug]");
  const updates = [];
  cards.forEach((card, idx) => {
    const slug = card.getAttribute("data-cat-slug");
    if (slug) updates.push({ slug, ordem: idx + 1 });
    // Atualiza badge visual imediatamente
    const badge = card.querySelector(".cat-card-ordem");
    if (badge) badge.textContent = `#${idx + 1}`;
  });

  if (updates.length === 0) return;

  try {
    // Atualiza todos em paralelo
    await Promise.all(
      updates.map(({ slug, ordem }) =>
        supa.from("categorias").update({ ordem }).eq("slug", slug),
      ),
    );
    console.log(
      "✅ Ordem das categorias salva:",
      updates.map((u) => `${u.slug}=${u.ordem}`).join(", "),
    );

    // Feedback visual sutil
    const toastId = "toast-ordem";
    let toast = document.getElementById(toastId);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = toastId;
      toast.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:#27ae60; color:white; padding:10px 22px; border-radius:24px;
        font-size:0.9rem; font-weight:600; z-index:9999;
        box-shadow:0 4px 16px rgba(0,0,0,0.2);
        animation: fadeInUp 0.3s ease;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = "✅ Ordem salva com sucesso!";
    toast.style.display = "block";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.display = "none";
    }, 2500);
  } catch (err) {
    console.error("Erro ao salvar ordem:", err);
    alert("Erro ao salvar nova ordem. Tente novamente.");
  }
}

// Carrega o Select no Modal de Produto
async function carregarSelectCategorias(valorAtual = null) {
  const { data } = await supa.from("categorias").select("*").order("ordem");
  const sel = document.getElementById("prod-cat");
  if (!sel) return;

  // Preserva seleção atual se não foi passado valorAtual
  const valorPreservar = valorAtual || sel.value;

  sel.innerHTML = '<option value="">— Sem categoria —</option>';
  if (data) {
    data.forEach(
      (c) =>
        (sel.innerHTML += `<option value="${c.slug}">${c.nome_exibicao}</option>`),
    );
  }

  // Restaura seleção
  if (valorPreservar) sel.value = valorPreservar;
}

// =========================================
// SISTEMA DE SUBCATEGORIAS
// =========================================

// Carrega subcategorias no select do modal de produto
async function carregarSelectSubcategorias(
  categoriaSlag = "",
  valorAtual = "",
) {
  const sel = document.getElementById("prod-subcat");
  const box = document.getElementById("box-subcategoria");
  if (!sel) return;

  sel.innerHTML = '<option value="">— Sem subcategoria —</option>';

  if (!categoriaSlag) {
    if (box) box.style.display = "none";
    return;
  }

  try {
    const { data, error } = await supa
      .from("subcategorias")
      .select("*")
      .eq("categoria_slug", categoriaSlag)
      .order("ordem");

    if (error) {
      console.warn("Subcategorias indisponíveis:", error.message);
      // Mostra o box mesmo assim (com só a opção "sem subcategoria")
      if (box) box.style.display = "block";
      return;
    }

    // Sempre mostra o campo quando uma categoria está selecionada
    if (box) box.style.display = "block";

    if (data && data.length > 0) {
      data.forEach(
        (s) =>
          (sel.innerHTML += `<option value="${s.slug}">${s.nome_exibicao}</option>`),
      );
      if (valorAtual) sel.value = valorAtual;
    }
  } catch (e) {
    console.warn("Erro ao buscar subcategorias:", e);
    // Mostra mesmo assim — melhor mostrar vazio do que esconder sem avisar
    if (box) box.style.display = "block";
  }
}

// Chamado quando o usuário muda a categoria no modal de produto
async function onCatChange() {
  const catSlug = document.getElementById("prod-cat").value;
  await carregarSelectSubcategorias(catSlug, "");
}

// --- CRUD DE SUBCATEGORIAS ---
let _catSlugAtualSubcat = "";

async function carregarSubcategorias(categoriaSlag) {
  _catSlugAtualSubcat = categoriaSlag;
  const wrapper = document.getElementById("lista-subcategorias-wrapper");
  if (!wrapper) return;

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h4 style="margin:0">Subcategorias de: <strong>${categoriaSlag}</strong></h4>
      <button class="btn btn-primary btn-sm" onclick="abrirModalSubcat()">+ Nova Subcategoria</button>
    </div>`;

  try {
    const { data, error } = await supa
      .from("subcategorias")
      .select("*")
      .eq("categoria_slug", categoriaSlag)
      .order("ordem");

    if (error) throw error;

    if (!data || data.length === 0) {
      html +=
        '<p style="color:#aaa;padding:10px 0">Nenhuma subcategoria criada ainda.</p>';
    } else {
      html +=
        '<table class="table"><thead><tr><th>Slug</th><th>Nome</th><th>Ordem</th><th></th></tr></thead><tbody>';
      data.forEach((s) => {
        const sJson = JSON.stringify(s)
          .replace(/'/g, "&apos;")
          .replace(/"/g, "&quot;");
        html += `<tr>
          <td>${s.slug}</td>
          <td>${s.nome_exibicao}</td>
          <td>${s.ordem}</td>
          <td class="actions-cell">
            <button class="btn btn-sm btn-info" onclick='editarSubcat(${sJson})'><i class="fas fa-edit"></i></button>
            <button class="btn btn-sm btn-danger" onclick="deletarSubcat('${s.slug}')"><i class="fas fa-trash"></i></button>
          </td>
        </tr>`;
      });
      html += "</tbody></table>";
    }
  } catch (e) {
    html += `<div style="background:#fff3cd;padding:12px;border-radius:8px;color:#856404;font-size:0.85rem">
      ⚠️ A tabela <strong>subcategorias</strong> ainda não existe no banco.<br>
      Execute o SQL abaixo no Supabase para ativá-la:<br><br>
      <code style="background:#f8f9fa;padding:4px 8px;border-radius:4px;font-size:0.8rem;display:block;white-space:pre-wrap">
CREATE TABLE subcategorias (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  nome_exibicao TEXT NOT NULL,
  categoria_slug TEXT REFERENCES categorias(slug) ON DELETE CASCADE,
  ordem INT DEFAULT 0
);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS subcategoria_slug TEXT REFERENCES subcategorias(slug) ON DELETE SET NULL;
      </code>
    </div>`;
  }

  wrapper.innerHTML = html;
}

function abrirModalSubcat(subcat = null) {
  const isEdit = !!subcat;
  const slugVal = subcat ? subcat.slug : "";
  const nomeVal = subcat ? subcat.nome_exibicao : "";
  const ordemVal = subcat ? subcat.ordem : "";

  const modalHtml = `
    <div id="modal-subcat" class="modal-overlay" style="display:flex">
      <div class="modal-content" style="max-width:400px">
        <h3>${isEdit ? "Editar Subcategoria" : "Nova Subcategoria"}</h3>
        <input type="hidden" id="subcat-modo" value="${isEdit ? "sim" : "nao"}">
        <input type="hidden" id="subcat-slug-original" value="${slugVal}">
        <div class="form-group">
          <label>Nome Exibição</label>
          <input type="text" id="subcat-nome" class="form-control" value="${nomeVal}" oninput="autoSlugFromSubcatNome()">
        </div>
        <div class="form-group">
          <label>Slug (ID único)</label>
          <input type="text" id="subcat-slug" class="form-control" value="${slugVal}">
          <small style="color:#888">Gerado automaticamente ou edite manualmente</small>
        </div>
        <div class="form-group">
          <label>Ordem</label>
          <input type="number" id="subcat-ordem" class="form-control" value="${ordemVal}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" onclick="salvarSubcat()">Salvar</button>
          <button class="btn btn-secondary" onclick="document.getElementById('modal-subcat').remove()">Cancelar</button>
        </div>
      </div>
    </div>`;

  // Remove modal anterior se existir
  document.getElementById("modal-subcat")?.remove();
  document.body.insertAdjacentHTML("beforeend", modalHtml);
}

function editarSubcat(s) {
  abrirModalSubcat(s);
}

function autoSlugFromSubcatNome() {
  const nome = document.getElementById("subcat-nome").value;
  const slug = gerarSlug(nome);
  document.getElementById("subcat-slug").value = slug;
}

async function salvarSubcat() {
  const modo = document.getElementById("subcat-modo").value;
  const slugOriginal = document.getElementById("subcat-slug-original").value;
  const nome = document.getElementById("subcat-nome").value.trim();
  const slug = document.getElementById("subcat-slug").value.trim();
  const ordem = parseInt(document.getElementById("subcat-ordem").value) || 0;

  if (!slug || !nome) return alert("Preencha o slug e o nome!");

  const dados = {
    slug,
    nome_exibicao: nome,
    categoria_slug: _catSlugAtualSubcat,
    ordem,
  };

  let erro = null;
  if (modo === "sim") {
    const { error } = await supa
      .from("subcategorias")
      .update(dados)
      .eq("slug", slugOriginal);
    erro = error;
  } else {
    const { error } = await supa.from("subcategorias").insert([dados]);
    erro = error;
  }

  if (erro) {
    alert("Erro ao salvar: " + erro.message);
  } else {
    document.getElementById("modal-subcat")?.remove();
    carregarSubcategorias(_catSlugAtualSubcat);
  }
}

async function deletarSubcat(slug) {
  if (
    !confirm(
      `Deletar a subcategoria "${slug}"?\n\nOs produtos vinculados ficarão sem subcategoria.`,
    )
  )
    return;

  // Desvincula produtos
  await supa
    .from("produtos")
    .update({ subcategoria_slug: null })
    .eq("subcategoria_slug", slug);

  const { error } = await supa.from("subcategorias").delete().eq("slug", slug);
  if (error) alert("Erro: " + error.message);
  else carregarSubcategorias(_catSlugAtualSubcat);
}

// Utilitário: gera slug a partir de um texto
function gerarSlug(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// Abre Modal de Edição (Recebe o objeto c inteiro)
function editarCategoria(c) {
  document.getElementById("titulo-modal-cat").innerText = "Editar Categoria";
  document.getElementById("cat-modo-edicao").value = "sim";

  const slugInput = document.getElementById("cat-slug");
  slugInput.value = c.slug;
  slugInput.readOnly = false; // Permite editar o slug
  slugInput.dataset.slugOriginal = c.slug; // Guarda o original para comparar

  document.getElementById("cat-nome").value = c.nome_exibicao;
  document.getElementById("cat-ordem").value = c.ordem;
  document.getElementById("cat-hora-inicio").value = c.hora_inicio || "";
  document.getElementById("cat-hora-fim").value = c.hora_fim || "";
  const diasSalvos = Array.isArray(c.dias_semana) ? c.dias_semana : [];
  document.querySelectorAll(".cat-dia-check").forEach((cb) => {
    cb.checked = diasSalvos.includes(cb.value);
  });

  document.getElementById("modal-cat").style.display = "flex";
}

async function salvarCategoria() {
  const slugInput = document.getElementById("cat-slug");
  const slug = slugInput.value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_");
  const nome = document.getElementById("cat-nome").value.trim();
  let ordemVal = parseInt(document.getElementById("cat-ordem").value);
  const modo = document.getElementById("cat-modo-edicao").value;
  const slugOriginal = slugInput.dataset.slugOriginal || slug;

  if (!slug || !nome) return alert("Preencha o slug e o nome!");

  // Se ordem não foi preenchida ou ficou 0 em modo inserção, busca a próxima automaticamente
  if ((!ordemVal || ordemVal === 0) && modo !== "sim") {
    const { data: ult } = await supa
      .from("categorias")
      .select("ordem")
      .order("ordem", { ascending: false })
      .limit(1);
    ordemVal =
      ult && ult.length > 0 && ult[0].ordem != null ? ult[0].ordem + 1 : 1;
  }

  let erro = null;

  if (modo === "sim") {
    const slugMudou = slug !== slugOriginal;

    if (slugMudou) {
      // 1. Insere novo registro com o novo slug
      const horaIni = document.getElementById("cat-hora-inicio").value || null;
      const horaFim = document.getElementById("cat-hora-fim").value || null;
      const dias = Array.from(
        document.querySelectorAll(".cat-dia-check:checked"),
      ).map((cb) => cb.value);
      const { error: insErr } = await supa.from("categorias").insert([
        {
          slug,
          nome: nome,
          nome_exibicao: nome,
          ordem: ordemVal,
          hora_inicio: horaIni,
          hora_fim: horaFim,
          dias_semana: dias.length > 0 ? dias : null,
        },
      ]);
      if (insErr) {
        alert("Erro ao salvar: " + insErr.message);
        return;
      }

      // 2. Migra todos os produtos do slug antigo para o novo
      await supa
        .from("produtos")
        .update({ categoria_slug: slug })
        .eq("categoria_slug", slugOriginal);

      // 3. Migra subcategorias (se existirem)
      try {
        await supa
          .from("subcategorias")
          .update({ categoria_slug: slug })
          .eq("categoria_slug", slugOriginal);
      } catch (_) {}

      // 4. Deleta o registro antigo
      const { error: delErr } = await supa
        .from("categorias")
        .delete()
        .eq("slug", slugOriginal);
      erro = delErr;
    } else {
      const { error } = await supa
        .from("categorias")
        .update({
          nome: nome,
          nome_exibicao: nome,
          ordem: ordemVal,
          hora_inicio: document.getElementById("cat-hora-inicio").value || null,
          hora_fim: document.getElementById("cat-hora-fim").value || null,
          dias_semana: (() => {
            const d = Array.from(
              document.querySelectorAll(".cat-dia-check:checked"),
            ).map((cb) => cb.value);
            return d.length > 0 ? d : null;
          })(),
        })
        .eq("slug", slugOriginal);
      erro = error;
    }
  } else {
    const { error } = await supa.from("categorias").insert([
      {
        slug,
        nome: nome,
        nome_exibicao: nome,
        ordem: ordemVal,
        hora_inicio: document.getElementById("cat-hora-inicio").value || null,
        hora_fim: document.getElementById("cat-hora-fim").value || null,
        dias_semana: (() => {
          const d = Array.from(
            document.querySelectorAll(".cat-dia-check:checked"),
          ).map((cb) => cb.value);
          return d.length > 0 ? d : null;
        })(),
      },
    ]);
    erro = error;
  }

  if (erro) alert("Erro ao salvar: " + erro.message);
  else {
    fecharModal("modal-cat");
    carregarCategorias();
  }
}

async function abrirModalCategoria() {
  document.getElementById("titulo-modal-cat").innerText = "Nova Categoria";
  document.getElementById("cat-modo-edicao").value = "nao";
  const slugInput = document.getElementById("cat-slug");
  slugInput.value = "";
  slugInput.readOnly = false;
  slugInput.dataset.slugOriginal = "";
  document.getElementById("cat-nome").value = "";
  document.getElementById("cat-hora-inicio").value = "";
  document.getElementById("cat-hora-fim").value = "";
  document
    .querySelectorAll(".cat-dia-check")
    .forEach((cb) => (cb.checked = false));

  // Auto-preenche a ordem com o próximo número
  try {
    const { data } = await supa
      .from("categorias")
      .select("ordem")
      .order("ordem", { ascending: false })
      .limit(1);
    const proximaOrdem =
      data && data.length > 0 && data[0].ordem != null ? data[0].ordem + 1 : 1;
    document.getElementById("cat-ordem").value = proximaOrdem;
  } catch (e) {
    document.getElementById("cat-ordem").value = "";
  }

  document.getElementById("modal-cat").style.display = "flex";
}

async function deletarProduto(id) {
  const confirmar = confirm(
    "⚠️ ATENÇÃO: Deletar este produto?\n\nEsta ação não pode ser desfeita. O produto será removido permanentemente do sistema.",
  );
  if (!confirmar) return;

  try {
    const { error } = await supa.from("produtos").delete().eq("id", id);
    if (error) {
      alert("❌ Erro ao deletar: " + error.message);
    } else {
      alert(t("alert.produto_excluido"));
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

async function pausarProduto(id, ativoAtual) {
  const novoStatus = !ativoAtual;
  const acao = novoStatus ? "reativar" : "pausar";
  if (!confirm(`Deseja ${acao} este produto?`)) return;

  const { error } = await supa
    .from("produtos")
    .update({ ativo: novoStatus })
    .eq("id", id);
  if (error) {
    alert("❌ Erro: " + error.message);
  } else {
    alert(novoStatus ? "✅ Produto reativado!" : "⏸️ Produto pausado!");
    carregarProdutos();
  }
}

async function deletarCat(slug) {
  // Verifica quantos produtos usam esta categoria
  const { count } = await supa
    .from("produtos")
    .select("*", { count: "exact", head: true })
    .eq("categoria_slug", slug);

  let msg = `⚠️ ATENÇÃO: Deletar a categoria "${slug}"?\n\nEsta ação não pode ser desfeita.`;
  if (count > 0) {
    msg += `\n\n⚠️ ${count} produto(s) usam esta categoria e ficarão sem categoria após a exclusão.`;
  }

  const confirmar = confirm(msg);
  if (!confirmar) return;

  try {
    // Primeiro: desvincula todos os produtos desta categoria
    if (count > 0) {
      await supa
        .from("produtos")
        .update({ categoria_slug: null, subcategoria_slug: null })
        .eq("categoria_slug", slug);
    }

    // Segundo: remove subcategorias vinculadas (se a tabela existir)
    try {
      await supa.from("subcategorias").delete().eq("categoria_slug", slug);
    } catch (_) {
      /* tabela pode não existir ainda */
    }

    // Terceiro: deleta a categoria
    const { error } = await supa.from("categorias").delete().eq("slug", slug);
    if (error) {
      alert("❌ Erro ao deletar: " + error.message);
    } else {
      alert("✅ Categoria deletada com sucesso!");
      carregarCategorias();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

// Abre o painel de subcategorias abaixo da tabela de categorias
function abrirPainelSubcategorias(categoriaSlug) {
  const painel = document.getElementById("lista-subcategorias-wrapper");
  if (!painel) return;
  painel.style.display = "block";
  painel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  carregarSubcategorias(categoriaSlug);
}

// Auto-gera o slug a partir do nome da categoria (modal de categoria)
function autoSlugFromNome() {
  const modo = document.getElementById("cat-modo-edicao")?.value;
  // Só auto-gera o slug se for criação (não edição)
  if (modo === "sim") return;
  const nome = document.getElementById("cat-nome").value;
  document.getElementById("cat-slug").value = gerarSlug(nome);
}

async function deletarMotoboy(id) {
  const confirmar = confirm(
    "⚠️ ATENÇÃO: Deletar este motoboy?\n\nEsta ação não pode ser desfeita.",
  );
  if (!confirmar) return;

  try {
    const { error } = await supa.from("motoboys").delete().eq("id", id);
    if (error) {
      if (
        error.code === "23503" ||
        (error.message && error.message.includes("foreign key"))
      ) {
        alert(
          "❌ Não é possível excluir este motoboy pois ele possui pedidos vinculados.\n\nDica: Você pode desativar o motoboy em vez de excluir.",
        );
      } else {
        alert("❌ Erro ao deletar: " + error.message);
      }
    } else {
      alert("✅ Motoboy deletado com sucesso!");
      carregarMotoboys();
      carregarMotoboysSelect();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}
async function carregarMotoboys() {
  const { data, error } = await supa.from("motoboys").select("*").order("nome");

  // Log limpo: só mostra se houver erro real
  if (error) console.error("❌ carregarMotoboys error:", error);

  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    const wrapper = document.getElementById("lista-motos-wrapper");
    let container = document.getElementById("mobile-motos");

    if (!container) {
      container = document.createElement("div");
      container.className = "mobile-cards-container";
      container.id = "mobile-motos";
      const tableContainer = wrapper.querySelector(".table-container");
      if (tableContainer) {
        wrapper.insertBefore(container, tableContainer);
      }
    }

    container.innerHTML = "";

    if (!error && data && data.length > 0) {
      data.forEach((m) => {
        const card = document.createElement("div");
        card.className = "mobile-card";
        card.innerHTML = `
                    <div class="mobile-card-header">
                        <div class="mobile-card-title">
                            <i class="fas fa-motorcycle" style="color:var(--primary);margin-right:8px;"></i>
                            ${m.nome}
                        </div>
                    </div>
                    <div class="mobile-card-body">
                        <div class="mobile-card-row">
                            <span class="mobile-card-label">Telefone:</span>
                            <span class="mobile-card-value">${m.telefone || "-"}</span>
                        </div>
                    </div>
                    <div class="mobile-card-actions">
                        <button class="btn btn-info" onclick='editarMoto(${JSON.stringify(m).replace(/'/g, "&apos;").replace(/"/g, "&quot;")})'>
                            <i class="fas fa-edit"></i> Editar
                        </button>
                        <button class="btn btn-danger" onclick="deletarMotoboy(${m.id})">
                            <i class="fas fa-trash"></i> Excluir
                        </button>
                    </div>
                `;
        container.appendChild(card);
      });
    } else {
      container.innerHTML =
        '<p style="text-align:center;padding:20px;color:#999">Nenhum motoboy cadastrado.</p>';
    }

    // Esconde tabela desktop no mobile
    const tableContainer = wrapper.querySelector(".table-container");
    if (tableContainer) tableContainer.style.display = "none";

    return;
  }

  // CÓDIGO DESKTOP
  const wrapper = document.getElementById("lista-motos-wrapper");
  const tableContainer = wrapper
    ? wrapper.querySelector(".table-container")
    : null;
  if (tableContainer) tableContainer.style.display = "block"; // Mostra tabela no desktop

  const tbody = document.getElementById("lista-motos");
  if (!tbody) {
    console.error("❌ Elemento lista-motos não encontrado!");
    return;
  }

  tbody.innerHTML = "";

  if (error) {
    console.error("❌ Erro ao carregar motoboys:", error);
    tbody.innerHTML =
      '<tr><td colspan="3" style="text-align:center;color:red">Erro ao carregar motoboys</td></tr>';
    return;
  }

  if (data && data.length > 0) {
    data.forEach((m) => {
      const mJson = JSON.stringify(m)
        .replace(/'/g, "'")
        .replace(/"/g, "&quot;");
      tbody.innerHTML += `
                <tr>
                    <td data-label="Nome">${m.nome}</td>
                    <td data-label="Telefone">${m.telefone || "-"}</td>
                    <td class="actions-cell">
                        <button class="btn btn-sm btn-info" onclick='editarMoto(${mJson})'>
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="deletarMotoboy(${m.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
    });
  } else {
    tbody.innerHTML =
      '<tr><td colspan="3" style="text-align:center">Nenhum motoboy cadastrado.</td></tr>';
  }
}

// Função chamada pelo botão editar
function editarMoto(m) {
  document.getElementById("moto-id").value = m.id;
  document.getElementById("moto-nome").value = m.nome;
  document.getElementById("moto-tel").value = m.telefone || "";
  document.getElementById("modal-moto").style.display = "flex";
}

function abrirModalMoto() {
  document.getElementById("moto-id").value = "";
  document.getElementById("moto-nome").value = "";
  document.getElementById("moto-tel").value = "";
  document.getElementById("modal-moto").style.display = "flex";
}

async function salvarMotoboy() {
  const dados = {
    nome: document.getElementById("moto-nome").value,
    telefone: document.getElementById("moto-tel").value,
  };
  const id = document.getElementById("moto-id").value;

  if (!dados.nome || !dados.nome.trim()) {
    alert("❌ Nome do motoboy é obrigatório!");
    return;
  }

  try {
    if (id) {
      const { error } = await supa.from("motoboys").update(dados).eq("id", id);
      if (error) throw error;
    } else {
      const { error } = await supa.from("motoboys").insert([dados]);
      if (error) throw error;
    }

    alert(t("alert.moto_salvo"));
    fecharModal("modal-moto");
    carregarMotoboys();
    carregarMotoboysSelect(); // Atualiza o select da Rota
  } catch (e) {
    alert("❌ Erro ao salvar: " + e.message);
  }
}

async function carregarMotoboysSelect() {
  const { data } = await supa.from("motoboys").select("*");
  const sel = document.getElementById("sel-motoboy");
  if (!sel) return;
  sel.innerHTML = '<option value="">Selecione...</option>';
  if (data) {
    data.forEach((m) => {
      sel.innerHTML += `<option value="${m.id}" data-tel="${m.telefone}" data-nome="${m.nome}">${m.nome}</option>`;
    });
  }
}

// =========================================
// MOTOBOYS (CORRIGIDO)
// =========================================

// === CONFIGURAÇÕES (COMPLETO) ===

function _getDiasSemana() {
  return [
    { key: "seg", label: t("dia.seg") },
    { key: "ter", label: t("dia.ter") },
    { key: "qua", label: t("dia.qua") },
    { key: "qui", label: t("dia.qui") },
    { key: "sex", label: t("dia.sex") },
    { key: "sab", label: t("dia.sab") },
    { key: "dom", label: t("dia.dom") },
  ];
}
// Mantém compatibilidade com referências diretas a DIAS_SEMANA
const DIAS_SEMANA = _getDiasSemana();

function _renderGradeSemanal(horariosSalvos = {}) {
  const container = document.getElementById("grade-semanal");
  if (!container) return;
  container.innerHTML = "";

  // Botão "Aplicar a todos"
  const applyBar = document.createElement("div");
  applyBar.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:10px 12px;background:var(--color-background-secondary);border-radius:10px;flex-wrap:wrap";
  applyBar.innerHTML = `
    <span style="font-size:0.82rem;font-weight:600;color:var(--color-text-secondary)">${t("grade.aplicar_titulo")}</span>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="time" id="apply-all-abre" style="padding:5px 8px;border:1.5px solid var(--color-border-secondary);border-radius:6px;font-size:0.85rem">
      <span style="font-size:0.8rem;color:var(--color-text-secondary)">→</span>
      <input type="time" id="apply-all-fecha" style="padding:5px 8px;border:1.5px solid var(--color-border-secondary);border-radius:6px;font-size:0.85rem">
      <button onclick="_aplicarHorarioTodos()" class="btn btn-sm btn-primary">${t("grade.aplicar_btn")}</button>
    </div>`;
  container.appendChild(applyBar);

  const ICONES_DIA = {
    seg: "☀️",
    ter: "☀️",
    qua: "☀️",
    qui: "☀️",
    sex: "🌟",
    sab: "🎉",
    dom: "🌙",
  };

  _getDiasSemana().forEach(({ key, label }) => {
    const dia = horariosSalvos[key] || {
      fechado: false,
      turnos: [{ abre: "", fecha: "" }],
    };
    const fechado = dia.fechado === true;
    const turnos =
      dia.turnos && dia.turnos.length > 0
        ? dia.turnos
        : [{ abre: "", fecha: "" }];

    const row = document.createElement("div");
    row.className = `gs-dia-card ${fechado ? "gs-fechado" : "gs-aberto"}`;
    row.dataset.dia = key;

    let turnosHtml = turnos
      .map(
        (turno, i) => `
      <div class="gs-turno-row" data-idx="${i}">
        <span class="gs-turno-label">${i === 0 ? t("grade.turno_1") : t("grade.turno_2")}</span>
        <div class="gs-turno-inputs">
          <div class="gs-time-group">
            <span class="gs-time-label">${t("grade.das")}</span>
            <input type="time" class="gs-time-input turno-abre" value="${turno.abre || ""}">
          </div>
          <span class="gs-time-sep">→</span>
          <div class="gs-time-group">
            <span class="gs-time-label">${t("grade.ate")}</span>
            <input type="time" class="gs-time-input turno-fecha" value="${turno.fecha || ""}">
          </div>
          ${i > 0 ? `<button class="gs-btn-rm" onclick="removerTurno(this)" title="Remover turno">✕</button>` : '<div style="width:28px"></div>'}
        </div>
      </div>`,
      )
      .join("");

    row.innerHTML = `
      <div class="gs-dia-header">
        <div class="gs-dia-info">
          <span class="gs-dia-icone">${ICONES_DIA[key] || "📅"}</span>
          <span class="gs-dia-nome">${label}</span>
        </div>
        <div class="gs-dia-controls">
          <span class="gs-status-badge ${fechado ? "gs-badge-fechado" : "gs-badge-aberto"}">
            ${fechado ? t("grade.fechado") : t("grade.aberto")}
          </span>
          <label class="gs-toggle-wrap">
            <input type="checkbox" class="dia-fechado-check" ${fechado ? "checked" : ""} onchange="toggleDiaFechado(this)">
            <span class="gs-toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="gs-dia-turnos" style="${fechado ? "display:none" : ""}">
        <div class="gs-turnos-lista">${turnosHtml}</div>
        <button class="gs-btn-add-turno btn-add-turno" onclick="adicionarTurno(this)">
          <i class="fas fa-plus"></i> ${t("grade.add_turno")}
        </button>
      </div>
    `;
    container.appendChild(row);
  });
}

function toggleDiaFechado(checkbox) {
  const row = checkbox.closest(".gs-dia-card");
  const turnos = row.querySelector(".gs-dia-turnos");
  const badge = row.querySelector(".gs-status-badge");
  if (checkbox.checked) {
    if (turnos) turnos.style.display = "none";
    row.classList.add("gs-fechado");
    row.classList.remove("gs-aberto");
    if (badge) {
      badge.textContent = t("grade.fechado");
      badge.className = "gs-status-badge gs-badge-fechado";
    }
  } else {
    if (turnos) turnos.style.display = "";
    row.classList.add("gs-aberto");
    row.classList.remove("gs-fechado");
    if (badge) {
      badge.textContent = t("grade.aberto");
      badge.className = "gs-status-badge gs-badge-aberto";
    }
  }
}

function adicionarTurno(btn) {
  const lista = btn.previousElementSibling;
  const idx = lista.querySelectorAll(".gs-turno-row").length;
  if (idx >= 2) {
    alert(t("grade.max_turnos"));
    return;
  }
  const div = document.createElement("div");
  div.className = "gs-turno-row";
  div.dataset.idx = idx;
  div.innerHTML = `
    <span class="gs-turno-label">${t("grade.turno_2")}</span>
    <div class="gs-turno-inputs">
      <div class="gs-time-group">
        <span class="gs-time-label">${t("grade.das")}</span>
        <input type="time" class="gs-time-input turno-abre">
      </div>
      <span class="gs-time-sep">→</span>
      <div class="gs-time-group">
        <span class="gs-time-label">${t("grade.ate")}</span>
        <input type="time" class="gs-time-input turno-fecha">
      </div>
      <button class="gs-btn-rm btn-rm-turno" onclick="removerTurno(this)" title="Remover turno">✕</button>
    </div>
  `;
  lista.appendChild(div);
}

function removerTurno(btn) {
  btn.closest(".gs-turno-row").remove();
}

function _aplicarHorarioTodos() {
  const abre = document.getElementById("apply-all-abre")?.value;
  const fecha = document.getElementById("apply-all-fecha")?.value;
  if (!abre || !fecha) {
    alert(t("grade.preencha_horario"));
    return;
  }
  document.querySelectorAll(".gs-dia-card").forEach((row) => {
    // Desmarca "fechado"
    const check = row.querySelector(".dia-fechado-check");
    if (check && check.checked) {
      check.checked = false;
      toggleDiaFechado(check);
    }
    // Remove turnos extras
    row.querySelectorAll(".gs-turno-row").forEach((t, i) => {
      if (i > 0) t.remove();
    });
    // Define horário do 1º turno
    const turnoAbre = row.querySelector(".turno-abre");
    const turnoFecha = row.querySelector(".turno-fecha");
    if (turnoAbre) turnoAbre.value = abre;
    if (turnoFecha) turnoFecha.value = fecha;
  });
  alert(t("grade.aplicado_ok"));
}

/* ══════════════════════════════════════════════
   SHAKE BUILDER — Tamanhos + Sabores
   ══════════════════════════════════════════════ */
function addShakeTamanho(dados = {}) {
  const lista = document.getElementById("shake-tamanhos-lista");
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "shake-tamanho-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #dde;border-radius:8px;padding:8px 10px;";
  row.innerHTML = `
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Nome</label>
      <input data-f="snome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: P, M, G, 500ml">
    </div>
    <div style="flex:1">
      <label style="font-size:0.72rem;color:#888">Volume (ml)</label>
      <input data-f="sml" type="number" class="form-control" value="${dados.ml || ""}" placeholder="400">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Preço (Gs)</label>
      <input data-f="spreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="15000">
    </div>
    <button onclick="this.closest('.shake-tamanho-row').remove()" style="background:none;border:none;color:#e74c3c;font-size:1.2rem;cursor:pointer;padding:0 4px;flex-shrink:0">✕</button>
  `;
  lista.appendChild(row);
}

function addShakeSabor(dados = {}) {
  const lista = document.getElementById("shake-sabores-lista");
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "shake-sabor-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #dde;border-radius:8px;padding:8px 10px;";
  row.innerHTML = `
    <div style="flex:3">
      <label style="font-size:0.72rem;color:#888">Sabor</label>
      <input data-f="snome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Morango, Chocolate">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Preço extra (Gs)</label>
      <input data-f="spreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">URL Foto (opcional)</label>
      <input data-f="simg" class="form-control" value="${dados.img || ""}" placeholder="https://...">
    </div>
    <button onclick="this.closest('.shake-sabor-row').remove()" style="background:none;border:none;color:#e74c3c;font-size:1.2rem;cursor:pointer;padding:0 4px;flex-shrink:0">✕</button>
  `;
  lista.appendChild(row);
}

function _popularShakeBuilder(shakeConfig) {
  document.getElementById("shake-tamanhos-lista").innerHTML = "";
  document.getElementById("shake-sabores-lista").innerHTML = "";
  if (!shakeConfig) return;
  (shakeConfig.tamanhos || []).forEach((t) => addShakeTamanho(t));
  (shakeConfig.sabores || []).forEach((s) => addShakeSabor(s));
}

function _lerGradeSemanal() {
  const horarios = {};
  document.querySelectorAll(".gs-dia-card").forEach((row) => {
    const key = row.dataset.dia;
    const fechado = row.querySelector(".dia-fechado-check").checked;
    const turnos = [];
    row.querySelectorAll(".gs-turno-row").forEach((t) => {
      const abre = t.querySelector(".turno-abre").value;
      const fecha = t.querySelector(".turno-fecha").value;
      if (abre || fecha) turnos.push({ abre, fecha });
    });
    horarios[key] = {
      fechado,
      turnos: fechado ? [] : turnos.length ? turnos : [{ abre: "", fecha: "" }],
    };
  });
  return horarios;
}

async function carregarConfiguracoes() {
  // Gestão de cupons: apenas dono, gerente e adminMaster
  const _cardCupons = document.getElementById("card-cupons-cfg");
  if (_cardCupons)
    _cardCupons.style.display = ["dono", "gerente", "adminMaster"].includes(
      perfilUsuario,
    )
      ? ""
      : "none";

  // Painel adminMaster
  const _cardAM = document.getElementById("card-adminmaster-cfg");
  if (_cardAM) {
    _cardAM.style.display = perfilUsuario === "adminMaster" ? "" : "none";
    if (perfilUsuario === "adminMaster") renderPainelFeatures();
  }

  const { data } = await supa.from("configuracoes").select("*").maybeSingle();
  _renderGradeSemanal((data && data.horarios_semanais) || {});
  _renderTabelaFrete((data && data.tabela_frete) || null);
  if (!data) return;

  const s = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? "";
  };
  // Operação
  s("cfg-aberta", data.loja_aberta ? "true" : "false");
  s("cfg-cotacao", data.cotacao_real);

  // Identidade da loja
  s("cfg-nome-restaurante", data.nome_restaurante);
  s("cfg-descricao-loja", data.descricao_loja);
  s("cfg-url-loja", data.url_loja);
  s("cfg-telefone-loja", data.telefone_loja);
  s("cfg-whatsapp-loja", data.whatsapp_loja);
  s("cfg-logo-url", data.logo_url || data.icone_url);

  // Pagamento
  s("cfg-chave-pix", data.chave_pix);
  s("cfg-nome-pix", data.nome_pix);
  s("cfg-dados-alias", data.dados_alias);
  s("cfg-nome-alias", data.nome_alias);

  // Localização
  s("cfg-coord-lat", data.coord_lat);
  s("cfg-coord-lng", data.coord_lng);

  // Banner 1
  s("cfg-banner-id", data.banner_produto_id || "");
  s("cfg-banner-img", data.banner_imagem || "");
  s("cfg-banner-desc-tipo", data.banner_desconto_tipo || "percentual");
  s("cfg-banner-desc-valor", data.banner_desconto_valor ?? "");
  if (data.banner_imagem) {
    const prev = document.getElementById("cfg-banner-preview");
    const box = document.getElementById("cfg-banner-preview-box");
    if (prev) prev.src = data.banner_imagem;
    if (box) box.style.display = "block";
  }
  // Banner 2
  s("cfg-banner2-id", data.banner2_produto_id || "");
  s("cfg-banner2-img", data.banner2_imagem || "");
  s("cfg-banner2-desc-tipo", data.banner2_desconto_tipo || "percentual");
  s("cfg-banner2-desc-valor", data.banner2_desconto_valor ?? "");
  if (data.banner2_imagem) {
    const prev2 = document.getElementById("cfg-banner2-preview");
    const box2 = document.getElementById("cfg-banner2-preview-box");
    if (prev2) prev2.src = data.banner2_imagem;
    if (box2) box2.style.display = "block";
  }

  // Visual
  const sc = (id, val) => {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  };
  sc("cfg-nome-loja", data.nome_restaurante || data.nome_loja);
  sc("cfg-cor-primaria", data.cor_primaria);
  sc("cfg-cor-primaria-hex", data.cor_primaria);

  const corPicker = document.getElementById("cfg-cor-primaria");
  const corHex = document.getElementById("cfg-cor-primaria-hex");
  if (corPicker && corHex) {
    corPicker.addEventListener("input", (e) => {
      corHex.value = e.target.value;
    });
    corHex.addEventListener("input", (e) => {
      if (e.target.value.startsWith("#") && e.target.value.length === 7)
        corPicker.value = e.target.value;
    });
  }

  const iconeUrlInput = document.getElementById("cfg-icone-url");
  const iconePreview = document.getElementById("cfg-icone-preview");
  const logoVal = data.logo_url || data.icone_url || "";
  if (iconeUrlInput) iconeUrlInput.value = logoVal;
  if (iconePreview && logoVal) {
    iconePreview.src = logoVal;
    iconePreview.style.display = "block";
  }

  // Globals
  if (data.nome_restaurante) NOME_RESTAURANTE = data.nome_restaurante;
  if (data.whatsapp_loja) WHATSAPP_LOJA_CFG = data.whatsapp_loja;
  if (data.coord_lat) COORD_LOJA.lat = parseFloat(data.coord_lat);
  if (data.coord_lng) COORD_LOJA.lng = parseFloat(data.coord_lng);
  if (data.chave_pix) CHAVE_PIX_CFG = data.chave_pix;
  if (data.nome_pix) NOME_PIX_CFG = data.nome_pix;
  if (data.dados_alias) DADOS_ALIAS_CFG = data.dados_alias;
  if (data.nome_alias) NOME_ALIAS_CFG = data.nome_alias;

  await carregarExtrasGlobaisAdmin();
  await _carregarMaquininhas();

  // Limite de distância e maquininhas
  s("cfg-limite-distancia", data.limite_distancia_km ?? "");
  s("cfg-taxa-motoboy-base", data.taxa_motoboy_base ?? 0);
  TAXA_MOTOBOY = data.taxa_motoboy_base ?? 0;
  const combEl = document.getElementById("cfg-combustivel");
  if (combEl) {
    const saved = data.ajuda_combustivel ?? 0;
    combEl.value = saved;
    AJUDA_COMBUSTIVEL = saved;
  }
}

async function salvarConfiguracoes() {
  const g = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : null;
  };
  const dados = {
    loja_aberta: g("cfg-aberta") === "true",
    cotacao_real: parseFloat(g("cfg-cotacao")) || 1100,
    banner_produto_id: parseInt(g("cfg-banner-id")) || null,
    banner_imagem: g("cfg-banner-img") || "",
    banner_desconto_tipo: g("cfg-banner-desc-tipo") || null,
    banner_desconto_valor: parseFloat(g("cfg-banner-desc-valor")) || null,
    banner2_produto_id: parseInt(g("cfg-banner2-id")) || null,
    banner2_imagem: g("cfg-banner2-img") || "",
    banner2_desconto_tipo: g("cfg-banner2-desc-tipo") || null,
    banner2_desconto_valor: parseFloat(g("cfg-banner2-desc-valor")) || null,
    horarios_semanais: _lerGradeSemanal(),
    // Identidade
    nome_restaurante: g("cfg-nome-restaurante") || "",
    descricao_loja: g("cfg-descricao-loja") || "",
    url_loja: g("cfg-url-loja") || "",
    telefone_loja: g("cfg-telefone-loja") || "",
    whatsapp_loja: (g("cfg-whatsapp-loja") || "").replace(/\D/g, ""),
    logo_url: g("cfg-logo-url") || "",
    icone_url: g("cfg-logo-url") || "",
    // Pagamento
    chave_pix: g("cfg-chave-pix") || "",
    nome_pix: g("cfg-nome-pix") || "",
    dados_alias: g("cfg-dados-alias") || "",
    nome_alias: g("cfg-nome-alias") || "",
    // Localização
    coord_lat: parseFloat(g("cfg-coord-lat")) || 0,
    coord_lng: parseFloat(g("cfg-coord-lng")) || 0,
    // Motoboy
    taxa_motoboy_base: parseInt(g("cfg-taxa-motoboy-base")) || 0,
    // Visual
    cor_primaria: g("cfg-cor-primaria") || "#1a7a2e",
  };

  // Aplica globals imediatamente
  NOME_RESTAURANTE = dados.nome_restaurante;
  WHATSAPP_LOJA_CFG = dados.whatsapp_loja;
  COORD_LOJA.lat = dados.coord_lat;
  COORD_LOJA.lng = dados.coord_lng;
  TAXA_MOTOBOY = dados.taxa_motoboy_base;
  CHAVE_PIX_CFG = dados.chave_pix;
  NOME_PIX_CFG = dados.nome_pix;
  DADOS_ALIAS_CFG = dados.dados_alias;
  NOME_ALIAS_CFG = dados.nome_alias;

  const { error } = await supa.from("configuracoes").update(dados).gt("id", 0);
  if (error) alert("Erro: " + error.message);
  else alert(t("alert.cfg_salvas"));
}

function previewBanner(input, num = 1) {
  if (!input.files || !input.files[0]) return;
  const suf = num === 2 ? "2" : "";
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById(`cfg-banner${suf}-preview`);
    const box = document.getElementById(`cfg-banner${suf}-preview-box`);
    if (prev) prev.src = e.target.result;
    if (box) box.style.display = "block";
  };
  reader.readAsDataURL(input.files[0]);
}

async function salvarBanner(num = 1) {
  const suf = num === 2 ? "2" : "";
  const fileInput = document.getElementById(`cfg-banner${suf}-file`);
  const prodId = document.getElementById(`cfg-banner${suf}-id`)?.value?.trim();
  const descTipo =
    document.getElementById(`cfg-banner${suf}-desc-tipo`)?.value || null;
  const descValor =
    parseFloat(document.getElementById(`cfg-banner${suf}-desc-valor`)?.value) ||
    null;

  if (!prodId) {
    alert("Informe o ID do produto para o banner.");
    return;
  }

  const btn = event.target;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
  btn.disabled = true;

  try {
    let urlFinal = document.getElementById(`cfg-banner${suf}-img`)?.value || "";

    if (fileInput?.files?.length) {
      const file = fileInput.files[0];
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Enviando imagem...';
      // ── Upload para o Cloudinary (substitui Supabase Storage) ──
      try {
        urlFinal = await uploadImageToImgbb(file);
      } catch (uploadErr) {
        alert(
          "❌ Falha no upload do banner: " +
            uploadErr.message +
            "\nO banner não foi salvo.",
        );
        return;
      }
    }

    if (!urlFinal) {
      alert("Selecione uma foto ou informe a URL do banner.");
      return;
    }

    const updateData = {};
    updateData[`banner${suf}_imagem`] = urlFinal;
    updateData[`banner${suf}_produto_id`] = parseInt(prodId) || null;
    updateData[`banner${suf}_desconto_tipo`] = descValor ? descTipo : null;
    updateData[`banner${suf}_desconto_valor`] = descValor || null;

    await supa.from("configuracoes").update(updateData).gt("id", 0);

    const imgEl = document.getElementById(`cfg-banner${suf}-img`);
    const prevEl = document.getElementById(`cfg-banner${suf}-preview`);
    const boxEl = document.getElementById(`cfg-banner${suf}-preview-box`);
    if (imgEl) imgEl.value = urlFinal;
    if (prevEl) prevEl.src = urlFinal;
    if (boxEl) boxEl.style.display = "block";

    alert(`✅ Banner ${num} ativado!`);
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    btn.innerHTML = '<i class="fas fa-upload"></i> Salvar Banner';
    btn.disabled = false;
  }
}
function previewIcone(input) {
  const file = input.files?.[0];
  const prev = document.getElementById("cfg-icone-preview");
  const box = document.getElementById("cfg-icone-preview-box");
  if (!prev) return;
  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      prev.src = e.target.result;
      if (box) box.style.display = "block";
    };
    reader.readAsDataURL(file);
  } else {
    if (box) box.style.display = "none";
  }
}

// =========================================================
// TABELA DE FRETE
// =========================================================
const FRETE_FAIXAS = [
  { label: "0 – 1 km", max: 1.0 },
  { label: "1,1 – 2 km", max: 2.0 },
  { label: "2,1 – 3 km", max: 3.0 },
  { label: "3,1 – 4 km", max: 4.0 },
  { label: "4,1 – 5 km", max: 5.0 },
  { label: "5,1 – 6 km", max: 6.0 },
  { label: "6,1 – 7 km", max: 7.0 },
  { label: "7,1 – 8 km", max: 8.0 },
  { label: "8,1 – 9 km", max: 9.0 },
  { label: "9,1 – 10 km", max: 10.0 },
  { label: "10,1 – 11 km", max: 11.0 },
  { label: "11,1 – 12 km", max: 12.0 },
  { label: "12,1 – 13 km", max: 13.0 },
  { label: "13,1 – 14 km", max: 14.0 },
  { label: "14,1 – 15 km", max: 15.0 },
  { label: "15,1 – 16 km", max: 16.0 },
  { label: "16,1 – 17 km", max: 17.0 },
  { label: "17,1 – 18 km", max: 18.0 },
  { label: "18,1 – 19 km", max: 19.0 },
  { label: "19,1 – 20 km", max: 20.0 },
];

function _renderTabelaFrete(savedData) {
  const tbody = document.getElementById("tabela-frete-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  FRETE_FAIXAS.forEach((faixa, idx) => {
    const saved = (savedData && savedData[idx]) || {};
    const valLoja = saved.loja ?? "";
    const valMoto = saved.motoboy ?? "";
    const aCombinar = saved.acombinar === true;
    const bg =
      idx % 2 === 0
        ? "var(--color-background-primary)"
        : "var(--color-background-secondary)";
    const rowStyle = aCombinar ? "opacity:0.6" : "";
    tbody.innerHTML += `
      <tr style="background:${bg};${rowStyle}" id="frete-row-${idx}">
        <td style="padding:8px;font-weight:600;white-space:nowrap;font-size:0.85rem">${faixa.label}</td>
        <td style="padding:6px;text-align:center">
          <input type="number" class="form-control frete-loja" data-idx="${idx}"
                 value="${aCombinar ? "" : valLoja}" placeholder="0" min="0" step="1000"
                 ${aCombinar ? "disabled" : ""}
                 style="text-align:center;max-width:120px;margin:0 auto;border:1.5px solid #2980b9;${aCombinar ? "opacity:0.4" : ""}">
        </td>
        <td style="padding:6px;text-align:center">
          <input type="number" class="form-control frete-motoboy" data-idx="${idx}"
                 value="${aCombinar ? "" : valMoto}" placeholder="0" min="0" step="1000"
                 ${aCombinar ? "disabled" : ""}
                 style="text-align:center;max-width:120px;margin:0 auto;border:1.5px solid #27ae60;${aCombinar ? "opacity:0.4" : ""}">
        </td>
        <td style="padding:6px;text-align:center">
          <label style="display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;font-size:0.78rem;color:${aCombinar ? "#e67e22" : "#aaa"}">
            <input type="checkbox" class="frete-acombinar" data-idx="${idx}" ${aCombinar ? "checked" : ""}
              onchange="_toggleFreteRow(${idx}, this.checked)"
              style="width:15px;height:15px">
            Combinar
          </label>
        </td>
      </tr>`;
  });
}

function _toggleFreteRow(idx, acombinar) {
  const row = document.getElementById(`frete-row-${idx}`);
  if (!row) return;
  const lojaInp = row.querySelector(".frete-loja");
  const motoInp = row.querySelector(".frete-motoboy");
  const lbl = row.querySelector("label");
  row.style.opacity = acombinar ? "0.6" : "1";
  if (lojaInp) {
    lojaInp.disabled = acombinar;
    lojaInp.style.opacity = acombinar ? "0.4" : "1";
    if (acombinar) lojaInp.value = "";
  }
  if (motoInp) {
    motoInp.disabled = acombinar;
    motoInp.style.opacity = acombinar ? "0.4" : "1";
    if (acombinar) motoInp.value = "";
  }
  if (lbl) lbl.style.color = acombinar ? "#e67e22" : "#aaa";
}

async function salvarTabelaFrete() {
  const tabela = [];
  FRETE_FAIXAS.forEach((_, idx) => {
    const acombinar =
      document.querySelector(`.frete-acombinar[data-idx="${idx}"]`)?.checked ||
      false;
    const loja = acombinar
      ? 0
      : parseInt(
          document.querySelector(`.frete-loja[data-idx="${idx}"]`)?.value,
        ) || 0;
    const motoboy = acombinar
      ? 0
      : parseInt(
          document.querySelector(`.frete-motoboy[data-idx="${idx}"]`)?.value,
        ) || 0;
    tabela.push({ loja, motoboy, acombinar });
  });

  const novoCombus =
    parseInt(document.getElementById("cfg-combustivel")?.value) || 0;
  const novoMotoBase =
    parseInt(document.getElementById("cfg-taxa-motoboy-base")?.value) || 0;
  const limiteKm =
    parseFloat(document.getElementById("cfg-limite-distancia")?.value) || null;
  AJUDA_COMBUSTIVEL = novoCombus;
  TAXA_MOTOBOY = novoMotoBase;

  const updateData = {
    tabela_frete: tabela,
    ajuda_combustivel: novoCombus,
    taxa_motoboy_base: novoMotoBase,
  };
  if (limiteKm) updateData.limite_distancia_km = limiteKm;
  else updateData.limite_distancia_km = null;

  const { error } = await supa
    .from("configuracoes")
    .update(updateData)
    .gt("id", 0);
  if (error) {
    alert("Erro ao salvar: " + error.message);
    return;
  }
  TABELA_FRETE_ADMIN = tabela;
  alert(t("alert.frete_salvo"));
}

// ── MAQUININHAS DE CARTÃO ─────────────────────────────────────────
async function _carregarMaquininhas() {
  const container = document.getElementById("maquininhas-lista");
  if (!container) return;
  const { data } = await supa
    .from("configuracoes")
    .select("maquininhas_cartao")
    .maybeSingle();
  const lista = data?.maquininhas_cartao || [];
  container.innerHTML = "";
  if (!lista.length) {
    container.innerHTML =
      '<p style="color:var(--color-text-secondary);font-size:0.82rem;padding:8px 0">Nenhuma maquininha cadastrada.</p>';
    return;
  }
  lista.forEach((m, idx) => _renderMaquininha(m, idx, container));
}

function _renderMaquininha(m, idx, container) {
  const row = document.createElement("div");
  row.className = "maquininha-row";
  row.style.cssText =
    "background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);border-radius:10px;padding:12px;margin-bottom:8px";
  row.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:700;font-size:0.9rem">${m.nome || "Maquininha " + (idx + 1)}</span>
      <button onclick="this.closest('.maquininha-row').remove()" style="background:none;border:none;color:#e74c3c;font-size:1rem;cursor:pointer">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;font-size:0.82rem">
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Nome/Operadora</label>
        <input class="form-control maq-nome" value="${m.nome || ""}" placeholder="Ex: Cielo, Rede, Sicredi"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Débito (%)</label>
        <input type="number" class="form-control maq-debito" value="${m.taxas?.debito ?? ""}" placeholder="1.5" min="0" step="0.01"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Crédito (%)</label>
        <input type="number" class="form-control maq-credito" value="${m.taxas?.credito ?? ""}" placeholder="2.5" min="0" step="0.01"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Parcelado (%)</label>
        <input type="number" class="form-control maq-parcelado" value="${m.taxas?.parcelado ?? ""}" placeholder="3.0" min="0" step="0.01"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">PIX (%)</label>
        <input type="number" class="form-control maq-pix" value="${m.taxas?.pix ?? ""}" placeholder="0.99" min="0" step="0.01"></div>
    </div>`;
  container.appendChild(row);
}

function adicionarMaquininha() {
  const container = document.getElementById("maquininhas-lista");
  if (!container) return;
  const p = container.querySelector("p");
  if (p) p.remove();
  _renderMaquininha(
    {},
    container.querySelectorAll(".maquininha-row").length,
    container,
  );
}

async function salvarMaquininhas() {
  const maquininhas = [];
  document
    .querySelectorAll("#maquininhas-lista .maquininha-row")
    .forEach((row) => {
      const nome = row.querySelector(".maq-nome")?.value.trim() || "";
      if (!nome) return;
      maquininhas.push({
        nome,
        taxas: {
          debito: parseFloat(row.querySelector(".maq-debito")?.value) || 0,
          credito: parseFloat(row.querySelector(".maq-credito")?.value) || 0,
          parcelado:
            parseFloat(row.querySelector(".maq-parcelado")?.value) || 0,
          pix: parseFloat(row.querySelector(".maq-pix")?.value) || 0,
        },
      });
    });
  const { error } = await supa
    .from("configuracoes")
    .update({ maquininhas_cartao: maquininhas })
    .gt("id", 0);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }
  alert("✅ Maquininhas salvas!");
}

async function salvarPersonalizacao() {
  const btn = event.target;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';
  btn.disabled = true;

  try {
    const dados = {};
    const nomeLoja =
      document.getElementById("cfg-nome-restaurante")?.value?.trim() ||
      document.getElementById("cfg-nome-loja")?.value?.trim();
    const corHex =
      document.getElementById("cfg-cor-primaria-hex")?.value ||
      document.getElementById("cfg-cor-primaria")?.value;
    const logoUrl = document.getElementById("cfg-logo-url")?.value?.trim();

    if (nomeLoja) {
      dados.nome_restaurante = nomeLoja;
    }
    if (corHex && corHex.startsWith("#")) dados.cor_primaria = corHex;
    if (logoUrl) {
      dados.logo_url = logoUrl;
      dados.icone_url = logoUrl;
    }

    // Upload do ícone se houver arquivo selecionado
    const iconeFile = document.getElementById("cfg-icone-file")?.files?.[0];
    if (iconeFile) {
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Enviando ícone...';
      // ── Upload para o Cloudinary (substitui Supabase Storage) ──
      let iconeUrl;
      try {
        iconeUrl = await uploadImageToImgbb(iconeFile);
      } catch (uploadErr) {
        alert(
          "❌ Falha no upload do ícone: " +
            uploadErr.message +
            "\nA personalização não foi salva.",
        );
        return;
      }
      dados.icone_url = iconeUrl;
      dados.logo_url = iconeUrl;
      // Atualiza preview
      const prev = document.getElementById("cfg-icone-preview");
      const box = document.getElementById("cfg-icone-preview-box");
      if (prev) {
        prev.src = iconeUrl;
      }
      if (box) {
        box.style.display = "block";
      }
      // Preenche campo URL
      const urlInp = document.getElementById("cfg-logo-url");
      if (urlInp) urlInp.value = iconeUrl;
    }

    if (Object.keys(dados).length > 0) {
      const { error } = await supa
        .from("configuracoes")
        .update(dados)
        .gt("id", 0);
      if (error) throw error;
    }
    if (dados.nome_restaurante) NOME_RESTAURANTE = dados.nome_restaurante;
    alert(
      "✅ Personalização salva! Recarregue o cardápio para ver as mudanças.",
    );
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    btn.innerHTML = '<i class="fas fa-paint-brush"></i> Salvar Personalização';
    btn.disabled = false;
  }
}

// ── Upload de logo direto da seção Identidade ────────────────────
async function _uploadLogoIdentidade(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const btn = input.closest("label");
  const originalHtml = btn ? btn.innerHTML : "";
  if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';

  try {
    // ── Upload para o Cloudinary (substitui Supabase Storage) ──
    const url = await uploadImageToImgbb(file);

    // Preenche o campo de URL de texto
    const urlInput = document.getElementById("cfg-logo-url");
    if (urlInput) urlInput.value = url;

    // Mostra preview
    const preview = document.getElementById("cfg-logo-preview-identidade");
    const img = document.getElementById("cfg-logo-img-identidade");
    if (img) img.src = url;
    if (preview) preview.style.display = "block";
  } catch (e) {
    alert("Erro ao enviar imagem: " + e.message);
  } finally {
    if (btn) btn.innerHTML = originalHtml;
  }
}

async function carregarDashboard() {
  // Saudação dinâmica
  const hora = new Date().getHours();
  const saudacao =
    hora < 12
      ? t("saudacao.manha")
      : hora < 18
        ? t("saudacao.tarde")
        : t("saudacao.noite");
  const elGreet = document.getElementById("dash-greeting");
  if (elGreet) elGreet.textContent = saudacao + " 👋";

  const elDate = document.getElementById("dash-date");
  if (elDate)
    elDate.textContent = new Date().toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

  // Data de hoje em Assunção (UTC-3) — usa hora do SERVIDOR, não o
  // relógio do dispositivo. À noite (depois de ~21h PY), o relógio do
  // navegador convertido pra UTC já mostra o dia seguinte, então usar
  // `new Date()` aqui fazia o Dashboard mostrar "hoje" como amanhã e
  // ficar zerado nas últimas horas do dia real.
  const _horaServDash = await _obterHoraServidor();
  const _hojePyDash = _horaServDash.date_py;
  const _offMs = _getAsuncionOffsetMs(new Date(_hojePyDash + "T12:00:00"));
  const hojeUTCInicio = new Date(new Date(_hojePyDash + "T00:00:00").getTime() + _offMs).toISOString();
  const hojeUTCFim    = new Date(new Date(_hojePyDash + "T23:59:59").getTime() + _offMs).toISOString();

  // Pedidos de hoje (todos exceto cancelado — igual ao Financeiro)
  const { data: pedidos } = await supa
    .from("pedidos")
    .select("*")
    .neq("status", "cancelado")
    .gte("created_at", hojeUTCInicio)
    .lte("created_at", hojeUTCFim);
  const total = pedidos
    ? pedidos.reduce((a, b) => {
        // Mesma regra do Financeiro: "Na Nota" ainda em aberto é dívida
        // do cliente, não dinheiro recebido — não conta como faturamento
        // até ser quitado (senão o Dashboard infla a receita do dia).
        const pagB = (b.forma_pagamento || "").toLowerCase();
        if (pagB === "nanota" && !(b.quitado_em && b.forma_pagamento_quitacao)) return a;
        return a + (b.total_geral || 0);
      }, 0)
    : 0;

  // Pedidos em preparo
  const { count: emPreparo } = await supa
    .from("pedidos")
    .select("*", { count: "exact", head: true })
    .eq("status", "em_preparo");

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.innerText = v;
  };
  setVal("kpi-vendas", `Gs ${total.toLocaleString("es-PY")}`);
  setVal("kpi-pedidos", pedidos ? pedidos.length : 0);

  // Bug #8 corrigido: soma frete_motoboy real de cada delivery.
  // A versão anterior multiplicava TAXA_MOTOBOY × total de pedidos,
  // incluindo balcão/retirada/local que não têm motoboy.
  const custoMotoReal = (pedidos || [])
    .filter((p) => p.tipo_entrega === "delivery")
    .reduce((acc, p) => acc + (Number(p.frete_motoboy) || TAXA_MOTOBOY || 0), 0);
  const qtdMotoboyUnicos = new Set(
    (pedidos || [])
      .filter((p) => p.tipo_entrega === "delivery" && p.motoboy_id)
      .map((p) => p.motoboy_id),
  ).size;
  const custoMotoTotal = custoMotoReal + (AJUDA_COMBUSTIVEL || 0) * (qtdMotoboyUnicos || 0);
  setVal("kpi-moto", `Gs ${custoMotoTotal.toLocaleString("es-PY")}`);
  setVal("kpi-em-preparo", emPreparo || 0);

  // === RANKING PRODUTOS ===
  await carregarRankingProdutos();

  // === RANKING CLIENTES ===
  await carregarRankingClientes();

  // (tabela legada removida)
}

// ══════════════════════════════════════════════════════════
// RANKING PRODUTOS com filtro de período
// ══════════════════════════════════════════════════════════
async function carregarRankingProdutos() {
  const sel = document.getElementById("rank-prod-periodo");
  const periodo = sel ? sel.value : "hoje";
  const customBox = document.getElementById("rank-prod-custom");
  if (customBox)
    customBox.style.display = periodo === "custom" ? "flex" : "none";
  const { inicio, fim } = _calcularIntervalo(
    periodo,
    "rank-prod-inicio",
    "rank-prod-fim",
  );

  // Conta vendas de todos os pedidos finalizados (exceto cancelado).
  // Usar só "entregue" excluía todas as vendas de balcão/PDV. (bug #3 corrigido)
  let query = supa
    .from("pedidos")
    .select("itens")
    .not("status", "eq", "cancelado");
  if (inicio) query = query.gte("created_at", inicio);
  if (fim) query = query.lte("created_at", fim);
  const { data } = await query;

  const cnt = {};
  (data || []).forEach((ped) => {
    (Array.isArray(ped.itens) ? ped.itens : []).forEach((item) => {
      const n = item.nome || item.n || "Produto";
      const q = parseInt(item.qtd || item.q || 1);
      cnt[n] = (cnt[n] || 0) + q;
    });
  });
  const ranking = Object.entries(cnt)
    .map(([nome, v]) => ({ nome, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 8);

  const el = document.getElementById("ranking-produtos-list");
  if (!el) return;
  if (!ranking.length) {
    el.innerHTML = '<div class="rank-vazio">Nenhuma venda no período</div>';
    return;
  }
  el.innerHTML = "";
  const max = ranking[0].v;
  ranking.forEach((p, i) => {
    const pct = Math.round((p.v / max) * 100);
    el.innerHTML += `<div class="rank-item">
      <div class="rank-pos rank-pos-${i + 1}">${i + 1}</div>
      <div class="rank-info">
        <div class="rank-name">${p.nome}</div>
        <div class="rank-bar-wrap"><div class="rank-bar" style="width:${pct}%"></div></div>
      </div>
      <div class="rank-val">${p.v}</div>
    </div>`;
  });
}

// ══════════════════════════════════════════════════════════
// RANKING CLIENTES com filtro de período + limpeza de "MESA X -"
// ══════════════════════════════════════════════════════════
async function carregarRankingClientes() {
  const sel = document.getElementById("rank-cli-periodo");
  const periodo = sel ? sel.value : "tudo";
  const customBox = document.getElementById("rank-cli-custom");
  if (customBox)
    customBox.style.display = periodo === "custom" ? "flex" : "none";
  const { inicio, fim } = _calcularIntervalo(
    periodo,
    "rank-cli-inicio",
    "rank-cli-fim",
  );

  // Conta clientes de todos os pedidos não cancelados. (bug #4 corrigido)
  let query = supa
    .from("pedidos")
    .select("cliente_nome, cliente_telefone, total_geral")
    .not("status", "eq", "cancelado")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (inicio) query = query.gte("created_at", inicio);
  if (fim) query = query.lte("created_at", fim);
  const { data } = await query;

  const map = {};
  (data || []).forEach((p) => {
    const nomeLimpo =
      (p.cliente_nome || "").replace(/^MESA\s+\d+\s*-\s*/i, "").trim() ||
      "Cliente";
    const tel = (p.cliente_telefone || "").trim();
    if (nomeLimpo === "Cliente" && tel.length < 5) return;
    const key = tel.length > 5 ? tel : "nome:" + nomeLimpo;
    if (!map[key]) map[key] = { nome: nomeLimpo, tel, qtd: 0, total: 0 };
    else if (nomeLimpo !== "Cliente" && map[key].nome === "Cliente")
      map[key].nome = nomeLimpo;
    map[key].qtd++;
    map[key].total += p.total_geral || 0;
  });

  const top = Object.values(map)
    .sort((a, b) => b.qtd - a.qtd)
    .slice(0, 8);
  const el = document.getElementById("ranking-clientes-list");
  if (!el) return;
  if (!top.length) {
    el.innerHTML = '<div class="rank-vazio">Nenhum cliente no período</div>';
    return;
  }
  el.innerHTML = "";
  const max = top[0].qtd;
  top.forEach((c, i) => {
    const pct = Math.round((c.qtd / max) * 100);
    el.innerHTML += `<div class="rank-item">
      <div class="rank-pos rank-pos-${i + 1}">${i + 1}</div>
      <div class="rank-info">
        <div class="rank-name">${c.nome}</div>
        ${c.tel ? `<div class="rank-sub"><i class="fas fa-phone"></i> ${c.tel}</div>` : ""}
        <div class="rank-bar-wrap"><div class="rank-bar rank-bar-purple" style="width:${pct}%"></div></div>
      </div>
      <div class="rank-val">${c.qtd}x</div>
    </div>`;
  });
}

// Utilitário: datas para os rankings
function _calcularIntervalo(periodo, idI, idF) {
  const now = new Date();
  let inicio = null,
    fim = null;
  if (periodo === "hoje") {
    inicio = now.toISOString().split("T")[0] + "T00:00:00";
  } else if (periodo === "7") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    inicio = d.toISOString().split("T")[0] + "T00:00:00";
  } else if (periodo === "30") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    inicio = d.toISOString().split("T")[0] + "T00:00:00";
  } else if (periodo === "mes") {
    inicio = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00:00`;
  } else if (periodo === "custom") {
    const elI = document.getElementById(idI);
    const elF = document.getElementById(idF);
    if (elI?.value) inicio = elI.value + "T00:00:00";
    if (elF?.value) fim = elF.value + "T23:59:59";
  }
  return { inicio, fim };
}

// ══════════════════════════════════════════════════════════
// PDV MOBILE — Tabs de navegação
// ══════════════════════════════════════════════════════════
function pdvMudarAba(aba, btn) {
  localStorage.setItem("app_pdv_aba", aba);
  document
    .querySelectorAll(".pdv-tab-btn")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");

  // Hide all panels, show the selected one
  document
    .querySelectorAll(".pdv-tab-panel")
    .forEach((el) => el.classList.remove("pdv-tab-active"));

  if (aba === "produtos") {
    document
      .getElementById("pdv-panel-produtos")
      ?.classList.add("pdv-tab-active");
  } else if (aba === "carrinho") {
    document
      .getElementById("pdv-panel-carrinho")
      ?.classList.add("pdv-tab-active");
  } else if (aba === "monitor") {
    // On mobile: show the mesas panel instead
    const panelMesas = document.getElementById("pdv-panel-mesas");
    const panelVenda = document.getElementById("pdv-panel-venda");
    if (panelMesas && window.innerWidth <= 768) {
      panelVenda.style.display = "none";
      panelMesas.style.display = "";
    } else {
      document
        .getElementById("pdv-panel-monitor")
        ?.classList.add("pdv-tab-active");
    }
  }
}

function pdvMudarView(view) {
  const panelVenda = document.getElementById("pdv-panel-venda");
  const panelMesas = document.getElementById("pdv-panel-mesas");
  const btnVenda = document.getElementById("pdv-view-btn-venda");
  const btnMesas = document.getElementById("pdv-view-btn-mesas");
  if (view === "venda") {
    if (panelVenda) panelVenda.style.display = "block";
    if (panelMesas) panelMesas.style.display = "none";
    if (btnVenda) btnVenda.classList.add("active");
    if (btnMesas) btnMesas.classList.remove("active");
  } else {
    if (panelVenda) panelVenda.style.display = "none";
    if (panelMesas) panelMesas.style.display = "block";
    if (btnVenda) btnVenda.classList.remove("active");
    if (btnMesas) btnMesas.classList.add("active");
    carregarMonitorMesas();
  }
}

function pdvIniciarTabs() {
  const isMobile = window.innerWidth <= 768;
  const tabsEl = document.getElementById("pdv-tabs");
  const footer = document.getElementById("pdv-mobile-footer");
  const headerBar = document.querySelector(".pdv-header-bar .pdv-view-btns");

  if (isMobile) {
    if (tabsEl) tabsEl.style.display = "flex";
    if (footer) footer.style.display = "flex";
    if (headerBar) headerBar.style.display = "none";
    // Mobile começa mostrando o cardápio
    document
      .querySelectorAll(".pdv-tab-btn")
      .forEach((b) => b.classList.remove("active"));

    const savedPdvAba = localStorage.getItem("app_pdv_aba") || "produtos";
    let activeBtn = null;
    if (tabsEl) {
      if (savedPdvAba === "produtos")
        activeBtn = tabsEl.querySelector(".pdv-tab-btn:nth-child(1)");
      else if (savedPdvAba === "carrinho")
        activeBtn = tabsEl.querySelector(".pdv-tab-btn:nth-child(2)");
      else if (savedPdvAba === "mesas")
        activeBtn = tabsEl.querySelector(".pdv-tab-btn:nth-child(3)");
    }
    pdvMudarAba(savedPdvAba, activeBtn);
  } else {
    if (tabsEl) tabsEl.style.display = "none";
    if (footer) footer.style.display = "none";
    if (headerBar) headerBar.style.display = "flex";
    // Desktop: mostra produtos e carrinho sempre
    [".pdv-carrinho", ".pdv-produtos"].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.classList.add("pdv-tab-active");
    });
    const panelVenda = document.getElementById("pdv-panel-venda");
    if (panelVenda) panelVenda.style.display = "block";
  }
}

async function logout() {
  const { error } = await supa.auth.signOut();
  if (error) alert("Erro ao sair: " + error.message);
  else window.location.href = "login.html";
}

// ─────────────────────────────────────────────────────────────
// ALTERAR SENHA
// ─────────────────────────────────────────────────────────────
function abrirModalAlterarSenha() {
  const html = `
    <div id="modal-alterar-senha" class="modal-overlay" style="display:flex;z-index:9999;backdrop-filter:blur(4px)">
      <div style="background:#fff;border-radius:20px;width:100%;max-width:420px;
        box-shadow:0 24px 60px rgba(0,0,0,0.18);overflow:hidden;font-family:inherit">
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#1a7a2e 100%);
          padding:24px 24px 20px;position:relative">
          <button onclick="document.getElementById('modal-alterar-senha').remove()"
            style="position:absolute;top:14px;right:16px;background:rgba(255,255,255,0.12);
            border:none;color:#fff;width:30px;height:30px;border-radius:50%;font-size:14px;
            cursor:pointer">✕</button>
          <div style="display:flex;align-items:center;gap:12px">
            <div style="background:rgba(255,255,255,0.12);border-radius:12px;padding:10px;font-size:22px">🔐</div>
            <div>
              <div style="color:#fff;font-size:1.1rem;font-weight:700">Alterar Senha</div>
              <div style="color:rgba(255,255,255,0.55);font-size:0.78rem;margin-top:2px">Escolha uma senha forte</div>
            </div>
          </div>
        </div>
        <!-- Body -->
        <div style="padding:22px 24px 18px">
          <div style="margin-bottom:16px">
            <label style="font-size:0.75rem;font-weight:600;color:#64748b;text-transform:uppercase;
              letter-spacing:.4px;display:block;margin-bottom:6px">Nova senha</label>
            <div style="position:relative">
              <input type="password" id="wl-nova-senha" placeholder="Digite a nova senha"
                autocomplete="new-password" oninput="_wlAvaliarSenha(this.value)"
                style="width:100%;padding:10px 42px 10px 13px;border:2px solid #e2e8f0;
                border-radius:10px;font-size:0.9rem;outline:none;box-sizing:border-box"
                onfocus="this.style.borderColor='#1a7a2e'" onblur="this.style.borderColor='#e2e8f0'"/>
              <span onclick="_wlToggleSenha('wl-nova-senha','wl-eye1')" id="wl-eye1"
                style="position:absolute;right:11px;top:50%;transform:translateY(-50%);
                cursor:pointer;font-size:17px;user-select:none">👁</span>
            </div>
            <!-- Barra de força -->
            <div style="margin-top:7px">
              <div style="display:flex;gap:4px;height:5px;border-radius:4px;overflow:hidden">
                <div id="wl-b1" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
                <div id="wl-b2" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
                <div id="wl-b3" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
                <div id="wl-b4" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
              </div>
              <div id="wl-forca-lbl" style="font-size:0.72rem;color:#aaa;margin-top:4px;min-height:14px"></div>
            </div>
            <!-- Critérios -->
            <div style="margin-top:9px;display:grid;grid-template-columns:1fr 1fr;gap:3px 10px">
              <div id="wl-c1" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Mín. 8 caracteres</div>
              <div id="wl-c2" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Número</div>
              <div id="wl-c3" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Maiúscula</div>
              <div id="wl-c4" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Caractere especial</div>
            </div>
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:0.75rem;font-weight:600;color:#64748b;text-transform:uppercase;
              letter-spacing:.4px;display:block;margin-bottom:6px">Confirmar senha</label>
            <div style="position:relative">
              <input type="password" id="wl-conf-senha" placeholder="Repita a nova senha"
                autocomplete="new-password" oninput="_wlVerificarMatch()"
                style="width:100%;padding:10px 42px 10px 13px;border:2px solid #e2e8f0;
                border-radius:10px;font-size:0.9rem;outline:none;box-sizing:border-box"
                onfocus="this.style.borderColor='#1a7a2e'" onblur="this.style.borderColor='#e2e8f0'"/>
              <span onclick="_wlToggleSenha('wl-conf-senha','wl-eye2')" id="wl-eye2"
                style="position:absolute;right:11px;top:50%;transform:translateY(-50%);
                cursor:pointer;font-size:17px;user-select:none">👁</span>
            </div>
            <div id="wl-match-lbl" style="font-size:0.78rem;margin-top:5px;min-height:16px"></div>
          </div>
          <div id="wl-msg-senha" style="display:none;color:#e74c3c;font-size:0.82rem;
            background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;margin-top:10px"></div>
        </div>
        <!-- Footer -->
        <div style="padding:0 24px 22px;display:flex;gap:10px">
          <button onclick="document.getElementById('modal-alterar-senha').remove()"
            style="flex:1;padding:11px;background:#f5f5f5;color:#666;border:none;border-radius:10px;
            font-size:0.88rem;font-weight:600;cursor:pointer">Cancelar</button>
          <button id="wl-btn-salvar-senha" onclick="wlSalvarNovaSenha()"
            style="flex:2;padding:11px;background:linear-gradient(135deg,#1a7a2e,#145a22);
            color:#fff;border:none;border-radius:10px;font-size:0.88rem;font-weight:700;cursor:pointer">
            🔒 Salvar Nova Senha
          </button>
        </div>
      </div>
    </div>`;
  const old = document.getElementById("modal-alterar-senha");
  if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", html);
  setTimeout(() => document.getElementById("wl-nova-senha")?.focus(), 120);
}

function _wlToggleSenha(inputId, spanId) {
  const inp = document.getElementById(inputId);
  const sp = document.getElementById(spanId);
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
  if (sp) sp.textContent = inp.type === "password" ? "👁" : "🙈";
}

function _wlAvaliarSenha(v) {
  const checks = [
    v.length >= 8,
    /\d/.test(v),
    /[A-Z]/.test(v),
    /[^A-Za-z0-9]/.test(v),
  ];
  const txts = [
    "Mín. 8 caracteres",
    "Número",
    "Maiúscula",
    "Caractere especial",
  ];
  const cores = ["#e2e8f0", "#ef4444", "#f97316", "#eab308", "#22c55e"];
  const labels = ["", "Fraca 😬", "Razoável 😐", "Boa 👍", "Forte 💪"];
  const score = checks.filter(Boolean).length;

  checks.forEach((ok, i) => {
    const el = document.getElementById("wl-c" + (i + 1));
    if (!el) return;
    el.textContent = (ok ? "✓ " : "✗ ") + txts[i];
    el.style.color = ok ? "#22c55e" : "#bbb";
  });
  for (let i = 1; i <= 4; i++) {
    const b = document.getElementById("wl-b" + i);
    if (b) b.style.background = i <= score ? cores[score] : "#e2e8f0";
  }
  const fl = document.getElementById("wl-forca-lbl");
  if (fl) {
    fl.textContent = labels[score];
    fl.style.color = cores[score];
  }
  _wlVerificarMatch();
}

function _wlVerificarMatch() {
  const a = document.getElementById("wl-nova-senha")?.value || "";
  const b = document.getElementById("wl-conf-senha")?.value || "";
  const lbl = document.getElementById("wl-match-lbl");
  const inp = document.getElementById("wl-conf-senha");
  if (!lbl || !b) return;
  const ok = a === b && b.length > 0;
  lbl.textContent = ok ? "✓ Senhas coincidem" : "✗ Senhas não coincidem";
  lbl.style.color = ok ? "#22c55e" : "#ef4444";
  if (inp)
    inp.style.borderColor =
      b.length > 0 ? (ok ? "#22c55e" : "#ef4444") : "#e2e8f0";
}

async function wlSalvarNovaSenha() {
  const nova = document.getElementById("wl-nova-senha")?.value || "";
  const conf = document.getElementById("wl-conf-senha")?.value || "";
  const msgEl = document.getElementById("wl-msg-senha");
  const showErr = (t) => {
    msgEl.textContent = t;
    msgEl.style.display = "block";
  };
  msgEl.style.display = "none";

  if (nova.length < 6)
    return showErr("A senha deve ter pelo menos 6 caracteres.");
  if (nova !== conf) return showErr("As senhas não coincidem.");

  const btn = document.getElementById("wl-btn-salvar-senha");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Salvando...";
    btn.style.opacity = ".7";
  }

  const { error } = await supa.auth.updateUser({ password: nova });

  if (btn) {
    btn.disabled = false;
    btn.textContent = "🔒 Salvar Nova Senha";
    btn.style.opacity = "1";
  }

  if (error) {
    showErr("Erro: " + error.message);
  } else {
    document.getElementById("modal-alterar-senha").remove();
    const toast = document.createElement("div");
    toast.textContent = "✅ Senha alterada com sucesso!";
    toast.style.cssText =
      "position:fixed;bottom:28px;left:50%;transform:translateX(-50%);" +
      "background:#1a7a2e;color:#fff;padding:12px 24px;border-radius:12px;font-weight:600;" +
      "font-size:0.9rem;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,0.2)";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }
}

// =========================================
// 9. VENDA BALCÃO (NOVA VERSÃO VISUAL)
// =========================================

// =========================================
// 9. VENDA BALCÃO (VISUAL / NOVO)
// =========================================
let carrinhoPDV = [];
let produtosCachePDV = [];
// Cotação carregada das configurações (fallback 1100)
let _cotacaoPDV = 1100;
let _taxaDebitoPDV = 1.99;
let _taxaCreditoPDV = 4.98;
let _cartaoBRTipoPDV = "debito";

async function carregarPDV() {
  // PDV carrega TODOS os produtos ativos (inclui pausado=null e pausado=false)
  // .neq("pausado", true) exclui NULLs no PostgREST — usar .or() para incluir
  const { data } = await supa
    .from("produtos")
    .select("*")
    .eq("ativo", true)
    .or("pausado.is.null,pausado.eq.false")
    .order("categoria_slug")
    .order("nome");
  produtosCachePDV = data || [];

  // Carrega categorias para exibir no PDV
  const { data: cats } = await supa
    .from("categorias")
    .select("*")
    .order("ordem");
  produtosCatsPDV = cats || [];

  // Carrega cotação atual das configurações
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("cotacao_real, taxa_debito, taxa_credito")
    .maybeSingle();
  if (cfg?.cotacao_real) _cotacaoPDV = Number(cfg.cotacao_real);
  if (cfg?.taxa_debito != null) _taxaDebitoPDV = Number(cfg.taxa_debito);
  if (cfg?.taxa_credito != null) _taxaCreditoPDV = Number(cfg.taxa_credito);
  // Aplica visibilidade das formas de pagamento no PDV
  const { data: featCfg } = await supa
    .from("configuracoes")
    .select("features_ativas")
    .maybeSingle();
  _aplicarFormasPagamentoPDV(featCfg?.features_ativas);

  // ── Sincroniza painel de abertura de caixa no PDV ────────────────
  await _carregarSessaoCaixa();
  _pdvAtualizarPainelCaixa();

  renderizarGridPDV();
  pdvCarregarClientes(); // Garante que o datalist esteja populado
  setTimeout(() => pdvAtualizarClienteNota(), 100); // Força a atualização do seletor
  atualizarBarraMesasAtivas();
  pdvIniciarTabs();
}

/**
 * Atualiza o mini-painel de status/abertura de caixa dentro do PDV.
 * Chamado após _carregarSessaoCaixa() para refletir o estado atual.
 */
function _pdvAtualizarPainelCaixa() {
  const elStatus = document.getElementById("pdv-status-caixa");
  const btnAbrir = document.getElementById("pdv-btn-abrir-caixa");
  const btnFechar = document.getElementById("pdv-btn-fechar-caixa");
  if (!elStatus) return;

  if (_sessaoCaixaAtiva) {
    const dAbr = new Date(_sessaoCaixaAtiva.aberto_em).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Asuncion",
    });
    elStatus.innerHTML = `<span style="color:#27ae60">🟢 Aberto desde ${dAbr}</span>`;
    if (btnAbrir) btnAbrir.style.display = "none";
    if (btnFechar) btnFechar.style.display = "flex";
  } else {
    elStatus.innerHTML = `<span style="color:#e74c3c">🔴 Caixa fechado — abra para registrar vendas</span>`;
    if (btnAbrir) btnAbrir.style.display = "flex";
    if (btnFechar) btnFechar.style.display = "none";
  }
}

let produtosCatsPDV = [];

let _pdvCatFiltro = "todos";

function pdvSelecionarTipo(tipo, btn) {
  const inp = document.getElementById("balcao-tipo-entrega");
  if (inp) inp.value = tipo;
  document
    .querySelectorAll(".pdv-tipo-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const delivRow = document.getElementById("pdv-delivery-row");
  if (delivRow) delivRow.style.display = tipo === "delivery" ? "" : "none";
  atualizarCarrinhoPDV();
}

function renderizarGridPDV(filtroNome = "") {
  const grid = document.getElementById("pdv-grid");
  if (!grid) return;
  grid.innerHTML = "";

  // Gera chips de categoria
  const filterBar = document.getElementById("pdv-cat-filter");
  if (filterBar) {
    filterBar.innerHTML = "";
    const allChip = document.createElement("button");
    allChip.className = `pdv-cat-chip${_pdvCatFiltro === "todos" ? " active" : ""}`;
    allChip.textContent = "TODOS";
    allChip.onclick = () => {
      _pdvCatFiltro = "todos";
      renderizarGridPDV(document.getElementById("pdv-busca")?.value || "");
    };
    filterBar.appendChild(allChip);

    const slugsUsados = [
      ...new Set(produtosCachePDV.map((p) => p.categoria_slug).filter(Boolean)),
    ];
    const ordemCats = produtosCatsPDV.map((c) => c.slug);
    slugsUsados.sort((a, b) => {
      const ia = ordemCats.indexOf(a),
        ib = ordemCats.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    slugsUsados.forEach((slug) => {
      const catInfo = produtosCatsPDV.find((c) => c.slug === slug);
      const chip = document.createElement("button");
      chip.className = `pdv-cat-chip${_pdvCatFiltro === slug ? " active" : ""}`;
      chip.textContent = (catInfo?.nome_exibicao || slug).toUpperCase();
      chip.onclick = () => {
        _pdvCatFiltro = slug;
        renderizarGridPDV(document.getElementById("pdv-busca")?.value || "");
      };
      filterBar.appendChild(chip);
    });
  }

  // Filtra produtos
  const query = filtroNome.toLowerCase().trim();
  let produtos = produtosCachePDV.filter((p) => {
    if (_pdvCatFiltro !== "todos" && p.categoria_slug !== _pdvCatFiltro)
      return false;
    if (query && !p.nome.toLowerCase().includes(query)) return false;
    return true;
  });

  if (_pdvCatFiltro !== "todos" || query) {
    // Flat grid sem cabeçalhos de categoria
    const row = document.createElement("div");
    row.className = "pdv-cat-row";
    produtos.forEach((p) => {
      row.appendChild(_criarCardPDV(p));
    });
    if (produtos.length === 0) {
      row.innerHTML = `<p style="color:#aaa;grid-column:1/-1;text-align:center;padding:20px">Nenhum produto encontrado</p>`;
    }
    grid.appendChild(row);
    return;
  }

  // Agrupa por categoria
  const porCategoria = {};
  produtosCachePDV.forEach((p) => {
    const cat = p.categoria_slug || "outros";
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(p);
  });

  const ordemCats = produtosCatsPDV.map((c) => c.slug);
  const slugsOrdenados = Object.keys(porCategoria).sort((a, b) => {
    const ia = ordemCats.indexOf(a),
      ib = ordemCats.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  slugsOrdenados.forEach((slug) => {
    const catInfo = produtosCatsPDV.find((c) => c.slug === slug);
    const catNome = catInfo ? catInfo.nome_exibicao : slug;

    const h = document.createElement("div");
    h.className = "pdv-cat-header";
    h.textContent = catNome;
    grid.appendChild(h);

    const row = document.createElement("div");
    row.className = "pdv-cat-row";
    porCategoria[slug].forEach((p) => row.appendChild(_criarCardPDV(p)));
    grid.appendChild(row);
  });
}

function _criarCardPDV(p) {
  const img = p.imagem_url || "";
  let cfg = p.montagem_config;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = null;
    }
  }
  const isKg = cfg && !Array.isArray(cfg) && cfg.__tipo === "kg";
  const precoKg = isKg ? cfg.preco_kg || p.preco || 0 : 0;

  const card = document.createElement("div");
  card.className = "pdv-card" + (isKg ? " pdv-card-kg" : "");
  card.title = p.nome;
  card.onclick = () => adicionarItemPDV(p);

  const imgHtml = img
    ? `<div class="pdv-card-img" style="background-image:url('${img}')"></div>`
    : `<div class="pdv-card-img pdv-card-img-none"><i class="fas fa-utensils"></i></div>`;

  const priceStr = isKg
    ? `Gs ${precoKg.toLocaleString("es-PY")}<span class="pdv-card-unit">/kg</span>`
    : `Gs ${p.preco.toLocaleString("es-PY")}`;

  const badge = isKg ? `<span class="pdv-card-kg-badge">⚖️ Kg</span>` : "";

  card.innerHTML = `
    ${imgHtml}
    <div class="pdv-card-body">
      <div class="pdv-card-name">${p.nome} ${badge}</div>
      <div class="pdv-card-price">${priceStr}</div>
    </div>`;
  return card;
}

// ── PDV — FUNÇÕES AUXILIARES ───────────────────────────────────────

// Estado F2 (consultar preço sem adicionar ao carrinho)
let _pdvF2Mode = false;

function togglePdvF2Mode() {
  _pdvF2Mode = !_pdvF2Mode;
  const btn = document.getElementById("pdv-f2-btn");
  const badge = document.getElementById("pdv-f2-badge");
  if (btn) btn.classList.toggle("active", _pdvF2Mode);
  if (badge) badge.style.display = _pdvF2Mode ? "inline-flex" : "none";
  const busca = document.getElementById("pdv-busca");
  if (busca) {
    busca.focus();
    busca.select();
  }
}

async function pdvBuscaKeydown(e) {
  const dropdown = document.getElementById("pdv-busca-resultados");
  const itens = dropdown ? [...dropdown.querySelectorAll(".pdv-resultado-item")] : [];

  // ── Navegação ↓↑ no dropdown ────────────────────────────
  if (e.key === "ArrowDown" && itens.length) {
    e.preventDefault();
    _pdvDropdownIdx = Math.min(_pdvDropdownIdx + 1, itens.length - 1);
    itens.forEach((el, i) => el.classList.toggle("pdv-resultado-ativo", i === _pdvDropdownIdx));
    itens[_pdvDropdownIdx]?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (e.key === "ArrowUp" && itens.length) {
    e.preventDefault();
    _pdvDropdownIdx = Math.max(_pdvDropdownIdx - 1, 0);
    itens.forEach((el, i) => el.classList.toggle("pdv-resultado-ativo", i === _pdvDropdownIdx));
    itens[_pdvDropdownIdx]?.scrollIntoView({ block: "nearest" });
    return;
  }

  // ── Escape: fecha dropdown, ou sai do F2 ─────────────────
  if (e.key === "Escape") {
    e.preventDefault();
    if (dropdown && dropdown.style.display !== "none") {
      _pdvFecharDropdown();
      return;
    }
    if (_pdvF2Mode) togglePdvF2Mode();
    return;
  }

  // ── F2 ───────────────────────────────────────────────────
  if (e.key === "F2") {
    e.preventDefault();
    togglePdvF2Mode();
    return;
  }

  // ── Enter ────────────────────────────────────────────────
  if (e.key === "Enter") {
    e.preventDefault();
    const busca = (e.target.value || "").trim();
    if (!busca) return;

    // Item ativo no dropdown → selecionar
    if (_pdvDropdownIdx >= 0 && itens[_pdvDropdownIdx]) {
      itens[_pdvDropdownIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return;
    }

    // Exatamente 1 resultado no dropdown → selecionar direto
    if (itens.length === 1) {
      itens[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return;
    }

    // Parece código de barras → buscar no banco
    const pareceBarcode =
      busca.length >= 6 && !busca.includes(" ") && /^[\d\w\-]+$/.test(busca);
    if (pareceBarcode) {
      const produto = await buscarProdutoPorBarcode(busca);
      if (produto) {
        if (_pdvF2Mode) {
          _pdvMostrarToast(
            `🔍 ${produto.nome} — Gs ${produto.preco.toLocaleString("es-PY")}`,
            "#1565c0",
            3000,
          );
        } else {
          if (typeof adicionarItemPDV === "function") adicionarItemPDV(produto);
          _pdvMostrarToast(`✅ ${produto.nome} adicionado!`, "#16a34a", 2000);
        }
        e.target.value = "";
        filtrarPDV("");
        return;
      }
    }

    // Fallback: clica no primeiro card visível que bate com a busca
    const buscaLow = busca.toLowerCase();
    const cards = document.querySelectorAll(".pdv-card");
    if (!cards.length) return;
    const primeiro =
      Array.from(cards).find((c) =>
        c.title?.toLowerCase().includes(buscaLow),
      ) || cards[0];
    primeiro?.click();
  }
}

// Estado cashback
let _pdvCashbackDisponivel = 0;
let _pdvCashbackUsando = false;

function pdvGetCashbackDesconto(total) {
  if (!_pdvCashbackUsando || _pdvCashbackDisponivel <= 0) return 0;
  return Math.min(_pdvCashbackDisponivel, total);
}

function pdvToggleCashback() {
  _pdvCashbackUsando = !_pdvCashbackUsando;
  const btn = document.getElementById("pdv-btn-usar-cash");
  if (btn) {
    btn.textContent = _pdvCashbackUsando
      ? "❌ Remover Cashback"
      : "💰 Usar Cashback";
    btn.style.background = _pdvCashbackUsando ? "#e74c3c" : "#ff9800";
  }
  atualizarCarrinhoPDV();
}

async function pdvTelefoneInput(tel) {
  tel = (tel || "").trim();
  const box = document.getElementById("pdv-cashback-box");
  if (!box) return;
  // Reseta estado ao mudar telefone
  _pdvCashbackDisponivel = 0;
  _pdvCashbackUsando = false;
  box.style.display = "none";
  if (tel.length < 7) return;
  try {
    const { data } = await supa
      .from("clientes")
      .select("nome, cashback_saldo")
      .eq("telefone", tel)
      .maybeSingle();
    if (data && data.cashback_saldo > 0) {
      _pdvCashbackDisponivel = data.cashback_saldo;
      const nomeEl = document.getElementById("pdv-cash-nome");
      const saldoEl = document.getElementById("pdv-cash-saldo");
      if (nomeEl) nomeEl.textContent = data.nome || "Cliente";
      if (saldoEl)
        saldoEl.textContent =
          "Gs " + data.cashback_saldo.toLocaleString("es-PY");
      box.style.display = "block";
    }
  } catch (_) {
    /* silencioso */
  }
}

// ── Fim funções auxiliares PDV ─────────────────────────────────────

// ── Dropdown de busca PDV ───────────────────────────────────────────
let _pdvDropdownIdx = -1; // índice do item ativo para navegação por teclado

function filtrarPDV(valor) {
  // Mantém o grid oculto sincronizado (compatibilidade com resto do código)
  renderizarGridPDV(valor);

  const dropdown = document.getElementById("pdv-busca-resultados");
  if (!dropdown) return;

  const query = (valor || "").trim();

  // Sem texto → fechar dropdown
  if (!query) {
    dropdown.style.display = "none";
    _pdvDropdownIdx = -1;
    return;
  }

  const ql = query.toLowerCase();
  const resultados = (produtosCachePDV || [])
    .filter((p) => p.ativo !== false &&
      (p.nome.toLowerCase().includes(ql) ||
       (p.codigo_barras && String(p.codigo_barras).includes(ql))))
    .slice(0, 30); // máximo 30 itens

  dropdown.innerHTML = "";
  _pdvDropdownIdx = -1;

  if (!resultados.length) {
    dropdown.innerHTML = `<div class="pdv-resultado-vazio">Nenhum produto encontrado para "<b>${query}</b>"</div>`;
    dropdown.style.display = "block";
    return;
  }

  resultados.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "pdv-resultado-item";
    item.dataset.idx = i;

    let cfg = p.montagem_config;
    if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch(_) { cfg = null; } }
    const isKg = cfg && !Array.isArray(cfg) && cfg.__tipo === "kg";
    const preco = isKg ? (cfg.preco_kg || p.preco || 0) : (p.preco || 0);
    const precoStr = `Gs ${preco.toLocaleString("es-PY")}${isKg ? "/kg" : ""}`;
    const catNome = (produtosCatsPDV || []).find(c => c.slug === p.categoria_slug)?.nome_exibicao || "";

    const fotoHtml = p.imagem_url
      ? `<img class="pdv-resultado-foto" src="${p.imagem_url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : ``;
    const fotoNone = `<div class="pdv-resultado-foto-none" ${p.imagem_url ? 'style="display:none"' : ''}><i class="fas fa-box"></i></div>`;

    item.innerHTML = `
      ${fotoHtml}${fotoNone}
      <div class="pdv-resultado-info">
        <div class="pdv-resultado-nome">${p.nome}${isKg ? ' <span style="font-size:0.72rem;color:#888">⚖️ kg</span>' : ''}</div>
        <div class="pdv-resultado-preco">${precoStr}</div>
        ${catNome ? `<div class="pdv-resultado-cat">${catNome}</div>` : ""}
      </div>`;

    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // evita blur antes do click
      _pdvSelecionarResultado(p);
    });

    dropdown.appendChild(item);
  });

  dropdown.style.display = "block";
}

function _pdvSelecionarResultado(p) {
  adicionarItemPDV(p);
  const input = document.getElementById("pdv-busca");
  if (input) { input.value = ""; input.focus(); }
  const dropdown = document.getElementById("pdv-busca-resultados");
  if (dropdown) { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
  _pdvDropdownIdx = -1;
}

function _pdvFecharDropdown() {
  const dropdown = document.getElementById("pdv-busca-resultados");
  if (dropdown) dropdown.style.display = "none";
  _pdvDropdownIdx = -1;
}

// Fechar dropdown ao clicar fora
document.addEventListener("click", (e) => {
  if (!e.target.closest("#pdv-busca-resultados") && e.target.id !== "pdv-busca") {
    _pdvFecharDropdown();
  }
});

// Categorias que NÃO recebem o upsell de extras globais
const _CATS_SEM_EXTRAS_GLOBAIS = [
  "bebidas",
  "bebida",
  "extras",
  "extra",
  "molhos",
  "adicionais",
];

// Extras globais configurados pelo admin
let _extrasGlobaisCache = null;
async function _getExtrasGlobais() {
  if (_extrasGlobaisCache !== null) return _extrasGlobaisCache;
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("extras_globais")
      .maybeSingle();
    _extrasGlobaisCache =
      data &&
      Array.isArray(data.extras_globais) &&
      data.extras_globais.length > 0
        ? data.extras_globais
        : []; // sem fallback hardcoded — se não configurado, não mostra upsell
  } catch (_e) {
    _extrasGlobaisCache = [];
  }
  return _extrasGlobaisCache;
}

function _deveMostrarExtrasGlobais(produto) {
  const cat = (produto.categoria_slug || "").toLowerCase();
  return !_CATS_SEM_EXTRAS_GLOBAIS.some((c) => cat.includes(c));
}

// ── Toast helper do PDV ───────────────────────────────────────────
function _pdvMostrarToast(msg, cor, duracao) {
  // Remove toast anterior se ainda visível
  document.getElementById("_pdv-toast")?.remove();
  const el = document.createElement("div");
  el.id = "_pdv-toast";
  el.style.cssText = `
    position:fixed;bottom:88px;left:50%;transform:translateX(-50%) translateY(8px);
    background:${cor || "#16a34a"};color:#fff;padding:11px 22px;border-radius:10px;
    font-weight:700;z-index:9999;font-size:0.92rem;box-shadow:0 4px 16px rgba(0,0,0,.22);
    opacity:0;transition:opacity .18s,transform .18s;pointer-events:none;white-space:nowrap`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
    setTimeout(() => el.remove(), 200);
  }, duracao || 2000);
}

function adicionarItemPDV(p) {
  // Combo/Kit → resolve componentes (e eventual escolha de variação) antes de adicionar
  if (p.tipo_produto === "combo") {
    _pdvAbrirComboVenda(p);
    return;
  }

  // montagem_config pode chegar como string JSON de bancos antigos
  let cfg = p.montagem_config;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = null;
    }
  }
  const tipo = cfg && !Array.isArray(cfg) && cfg.__tipo ? cfg.__tipo : null;

  // Kg → modal de peso/balança
  if (tipo === "kg") {
    _mostrarModalPesoPDV(p, cfg.preco_kg || p.preco || 0);
    return;
  }

  // Tipos com seleção obrigatória → abre modal de opções
  if (tipo === "variacoes" && cfg.variacoes?.length > 0) {
    const ativas = cfg.variacoes.filter((v) => v.ativo !== false);
    if (!ativas.length) {
      alert("⏸️ Todas as variações estão pausadas.");
      return;
    }
    _mostrarModalOpcoesPDV(p, "variacoes");
    return;
  }
  if (tipo === "pizza") {
    _mostrarModalOpcoesPDV(p, "pizza");
    return;
  }
  if (tipo === "acai") {
    _mostrarModalOpcoesPDV(p, "acai");
    return;
  }
  if (tipo === "shake") {
    _mostrarModalOpcoesPDV(p, "shake");
    return;
  }
  if (tipo === "suco") {
    _mostrarModalOpcoesPDV(p, "suco");
    return;
  }
  if (tipo === "sorvete") {
    _mostrarModalOpcoesPDV(p, "sorvete");
    return;
  }
  if (tipo === "montavel" && cfg.etapas?.length > 0) {
    _mostrarModalOpcoesPDV(p, "montavel");
    return;
  }

  // Simples / Lanche / Bebida / Combo — adiciona direto
  const existe = carrinhoPDV.find((i) => i.id === p.id && !i.variacao);
  const item = { 
    ...p, 
    qtd: 1, 
    montagem: [], 
    obs: "",
    variacao_id: null  // ← ADICIONADO: campo para variação (não há)
  };
  if (existe) existe.qtd++;
  else carrinhoPDV.push(item);
  
  atualizarCarrinhoPDV();

  if (_deveMostrarExtrasGlobais(p)) {
    _getExtrasGlobais().then((extras) => {
      if (extras?.length > 0) _mostrarUpsellExtrasPDV(p, extras);
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   COMBOS / KITS — venda no PDV
   Um combo consome quantidades pré-definidas de outros produtos
   (fracionadas em ml/g, ou por unidade). Se algum componente
   permite escolher variação (ex: sabor do gelo), pede a escolha
   antes de adicionar ao carrinho.
   ══════════════════════════════════════════════════════════════ */
async function _pdvAbrirComboVenda(produto) {
  const { data: componentes, error } = await supa
    .from("combo_componentes")
    .select("id, componente_produto_id, quantidade, unidade, permite_variacao, ordem")
    .eq("combo_produto_id", produto.id)
    .order("ordem");

  if (error) {
    alert("⚠️ Erro ao carregar componentes do combo: " + error.message);
    return;
  }
  if (!componentes?.length) {
    alert("⚠️ Este combo não possui componentes configurados. Edite o produto em Produtos.");
    return;
  }

  const idsComponentes = [...new Set(componentes.map((c) => c.componente_produto_id))];
  const { data: produtosComponentes } = await supa
    .from("produtos")
    .select("id, nome")
    .in("id", idsComponentes);
  const nomeMap = {};
  (produtosComponentes || []).forEach((pc) => (nomeMap[pc.id] = pc.nome));

  const componentesComVariacao = componentes.filter((c) => c.permite_variacao);
  let variacoesPorComponente = {};
  if (componentesComVariacao.length) {
    const idsComVar = [...new Set(componentesComVariacao.map((c) => c.componente_produto_id))];
    const { data: variacoes } = await supa
      .from("produto_variacoes")
      .select("id, produto_id, nome, ativo, ordem")
      .in("produto_id", idsComVar)
      .eq("ativo", true)
      .order("ordem");
    (variacoes || []).forEach((v) => {
      (variacoesPorComponente[v.produto_id] ||= []).push(v);
    });
  }

  const listaFinal = componentes.map((c) => ({
    componente_produto_id: c.componente_produto_id,
    nome: nomeMap[c.componente_produto_id] || "Produto",
    quantidade: c.quantidade,
    unidade: c.unidade,
    permite_variacao: c.permite_variacao,
    variacoes_disponiveis: variacoesPorComponente[c.componente_produto_id] || [],
    variacao_id: null,
    variacao_nome: null,
  }));

  const precisaEscolher = listaFinal.some(
    (c) => c.permite_variacao && c.variacoes_disponiveis.length > 0,
  );

  if (precisaEscolher) {
    _mostrarModalComboVariacoesPDV(produto, listaFinal);
  } else {
    _pdvAdicionarComboAoCarrinho(produto, listaFinal);
  }
}

function _pdvAdicionarComboAoCarrinho(produto, componentesResolvidos) {
  carrinhoPDV.push({
    id: produto.id,
    nome: produto.nome,
    img: produto.imagem_url,
    categoria_slug: produto.categoria_slug || "",
    preco: produto.preco || 0,
    qtd: 1,
    tipo_produto: "combo",
    combo_componentes: componentesResolvidos.map((c) => ({
      componente_produto_id: c.componente_produto_id,
      nome: c.nome,
      quantidade: c.quantidade,
      unidade: c.unidade,
      variacao_id: c.variacao_id,
      variacao_nome: c.variacao_nome,
    })),
    variacao: null,
    variacao_id: null,
    montagem: [],
    obs: "",
  });
  atualizarCarrinhoPDV();
}

function _mostrarModalComboVariacoesPDV(produto, componentes) {
  document.getElementById("pdv-combo-var-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "pdv-combo-var-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:16px;padding:20px;max-width:440px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)";

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <h4 style="margin:0;font-size:1rem;color:#333">🧩 ${produto.nome}</h4>
      <button id="_pdv-combo-var-close" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>
    </div>
    <p style="font-size:0.85rem;color:#666;margin:0 0 14px">Escolha as opções deste combo</p>
    <div id="pdv-combo-var-campos" style="display:flex;flex-direction:column;gap:14px"></div>
    <button id="_pdv-combo-var-confirmar" style="margin-top:16px;width:100%;padding:11px;background:var(--primary);color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer">
      Adicionar ao pedido
    </button>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector("#_pdv-combo-var-close").onclick = () => overlay.remove();

  const campos = modal.querySelector("#pdv-combo-var-campos");
  componentes.forEach((c, idx) => {
    if (!c.permite_variacao || !c.variacoes_disponiveis.length) return;
    const bloco = document.createElement("div");
    bloco.innerHTML = `
      <label style="display:block;font-weight:600;font-size:0.85rem;margin-bottom:6px;color:#1e293b">${c.nome}</label>
      <select data-idx="${idx}" class="form-control combo-var-select" style="font-size:0.88rem">
        ${c.variacoes_disponiveis.map((v) => `<option value="${v.id}">${v.nome}</option>`).join("")}
      </select>
    `;
    campos.appendChild(bloco);
  });

  modal.querySelector("#_pdv-combo-var-confirmar").onclick = () => {
    modal.querySelectorAll(".combo-var-select").forEach((sel) => {
      const idx = parseInt(sel.dataset.idx);
      const variacaoId = parseInt(sel.value);
      const variacao = componentes[idx].variacoes_disponiveis.find((v) => v.id === variacaoId);
      componentes[idx].variacao_id = variacaoId;
      componentes[idx].variacao_nome = variacao?.nome || null;
    });
    _pdvAdicionarComboAoCarrinho(produto, componentes);
    overlay.remove();
  };
}

// ── Modal unificado de opções para PDV ────────────────────────────
// Cobre: variacoes, pizza, acai, shake, suco, sorvete, montavel
function _mostrarModalOpcoesPDV(produto, tipo) {
  document.getElementById("pdv-opcoes-modal")?.remove();

  let cfg = produto.montagem_config || {};
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = {};
    }
  }
  const cacheKey = "pdv_" + (produto.id || Date.now());
  window._pdvProdCache[cacheKey] = produto;

  const overlay = document.createElement("div");
  overlay.id = "pdv-opcoes-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:flex-end;justify-content:center;padding:0";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:20px 20px 0 0;width:100%;max-width:520px;max-height:88vh;overflow-y:auto;padding:20px 16px 32px;box-shadow:0 -8px 40px rgba(0,0,0,0.2)";

  // Header
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div>
        <div style="font-weight:800;font-size:1rem;color:#1a1a1a">${produto.nome}</div>
        <div style="font-size:0.8rem;color:#888">Gs ${(produto.preco || 0).toLocaleString("es-PY")}</div>
      </div>
      <button onclick="document.getElementById('pdv-opcoes-modal').remove()"
        style="background:#f3f4f6;border:none;border-radius:50%;width:32px;height:32px;font-size:1.1rem;cursor:pointer;color:#666">✕</button>
    </div>
    <div id="_pdv-modal-corpo"></div>
    <div id="_pdv-obs-row" style="margin-top:12px">
      <label style="font-size:0.8rem;font-weight:600;color:#555">Observações</label>
      <input type="text" id="_pdv-obs-input" class="form-control" placeholder="Ex: sem cebola, bem passado..." style="margin-top:4px">
    </div>
    <button id="_pdv-modal-add" onclick="_pdvModalConfirmar('${cacheKey}')"
      style="width:100%;padding:14px;background:var(--primary,#1a7a2e);color:#fff;border:none;border-radius:12px;font-size:1rem;font-weight:800;cursor:pointer;margin-top:16px">
      ✅ Adicionar ao Pedido
    </button>`;

  const corpo = () => modal.querySelector("#_pdv-modal-corpo");

  // ── VARIAÇÕES ────────────────────────────────────────────────
  if (tipo === "variacoes") {
  const ativas = (cfg.variacoes || []).filter((v) => v.ativo !== false);
  corpo().innerHTML = `<p style="font-size:0.82rem;color:#555;margin-bottom:10px;font-weight:600">Escolha a variação:</p>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${ativas
        .map(
          (v, i) => {
            const precoExibido = (v.preco_adicional && v.preco_adicional > 0) ? v.preco_adicional : produto.preco;
            return `
            <label style="display:flex;align-items:center;gap:12px;border:2px solid #e5e7eb;border-radius:10px;padding:10px 12px;cursor:pointer;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>l.style.borderColor='#e5e7eb');this.style.borderColor='var(--primary)';this.style.background='#f0fff4'">
              <input type="radio" name="_pdv_var" value="${i}" style="width:18px;height:18px" ${i === 0 ? "checked" : ""}>
              ${v.img || produto.imagem_url ? `<img src="${v.img || produto.imagem_url}" style="width:44px;height:44px;border-radius:8px;object-fit:cover" onerror="this.style.display='none'">` : ""}
              <div style="flex:1"><div style="font-weight:700;font-size:0.9rem">${v.nome}</div></div>
              <div style="font-weight:700;color:var(--primary)">Gs ${precoExibido.toLocaleString("es-PY")}</div>
            </label>`;
          }
        )
        .join("")}
    </div>`;
}

  // ── PIZZA ────────────────────────────────────────────────────
  else if (tipo === "pizza") {
    const tamanhos = cfg.tamanhos || [];
    const sabores = cfg.sabores || [];
    const bordas = cfg.bordas || [];

    // ── Helpers de preço (igual ao app.js) ──────────────────────
    // Retorna o preço do tamanho para um determinado tipo de sabor
    const _pdvPrecoTipo = (tam, tipo) => {
      if (!tam) return 0;
      const precos = tam.precos || {};
      if (tipo && precos[tipo] > 0) return precos[tipo];
      if (tipo) {
        const k = Object.keys(precos).find(
          (k2) => k2.toLowerCase() === (tipo || "").toLowerCase(),
        );
        if (k && precos[k] > 0) return precos[k];
      }
      return tam.preco || 0;
    };
    // Retorna o menor preço disponível no tamanho (preço base)
    const _pdvPrecoMin = (tam) => {
      if (!tam) return 0;
      const vals = Object.values(tam.precos || {}).filter((v) => v > 0);
      return vals.length ? Math.min(...vals) : tam.preco || 0;
    };

    let html = "";

    // ── Passo 1: Tamanho (cards com fatias, cm e preço — igual ao app.js) ──
    if (tamanhos.length) {
      html += `<div style="margin-bottom:14px">
        <p style="font-size:0.82rem;font-weight:700;color:#e74c3c;margin-bottom:8px">📐 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px" id="_pdv_pizza_tam_grid">
          ${tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#e74c3c" : "#e5e7eb"};background:${i === 0 ? "#fff5f5" : ""};border-radius:10px;padding:10px 12px;cursor:pointer;text-align:center;min-width:80px;transition:all .15s"
              onclick="this.closest('#_pdv_pizza_tam_grid').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#e74c3c';this.style.background='#fff5f5';_pdvPizzaAtualizarPreco()">
              <input type="radio" name="_pdv_pizza_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              <div style="font-weight:700;font-size:0.9rem">${t.nome}</div>
              ${t.fatias ? `<div style="font-size:0.7rem;color:#888">${t.fatias} fatias</div>` : ""}
              ${t.cm ? `<div style="font-size:0.7rem;color:#888">⌀${t.cm}cm</div>` : ""}
              <div style="font-size:0.82rem;font-weight:800;color:#e74c3c;margin-top:3px">Gs ${(t.preco || 0).toLocaleString("es-PY")}</div>
            </label>`,
            )
            .join("")}
        </div>
      </div>`;
    }

    // ── Passo 2: Sabores — cada card mostra o preço do seu tipo (igual ao app.js) ──
    const maxSabDefault = tamanhos[0]?.max_sabores || 2;
    const tam0 = tamanhos[0];
    const precoMin0 = _pdvPrecoMin(tam0);
    html += `<div style="margin-bottom:14px">
      <p style="font-size:0.82rem;font-weight:700;color:#e74c3c;margin-bottom:8px">🍽️ Sabores <span id="_pdv_pizza_maxlabel" style="font-weight:400;color:#888">(até ${maxSabDefault})</span>:</p>
      <div id="_pdv_sabores_lista" style="display:flex;flex-direction:column;gap:6px">
        ${sabores
          .map((s) => {
            const precoEste0 = _pdvPrecoTipo(tam0, s.tipo);
            const diff0 = precoEste0 - precoMin0;
            const precoLbl =
              diff0 > 0
                ? `<span id="_pdv_sp_${s.nome.replace(/[^a-zA-Z0-9]/g, "_")}" style="font-size:0.78rem;font-weight:700;color:#e74c3c;white-space:nowrap">+Gs ${diff0.toLocaleString("es-PY")}</span>`
                : `<span id="_pdv_sp_${s.nome.replace(/[^a-zA-Z0-9]/g, "_")}" style="font-size:0.78rem;font-weight:700;color:#e74c3c;white-space:nowrap"></span>`;
            const tipoBadge = s.tipo
              ? `<span style="font-size:0.68rem;background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 6px;margin-left:4px;font-weight:600">${s.tipo}</span>`
              : "";
            return `
            <label style="display:flex;align-items:center;gap:10px;border:1.5px solid #e5e7eb;border-radius:8px;padding:8px 10px;cursor:pointer;transition:all .15s"
              data-tipo-sabor="${s.tipo || ""}"
              onclick="(function(el){var cb=el.querySelector('input[type=checkbox]');if(!cb.checked){var t=parseInt(document.getElementById('_pdv_pizza_maxlabel').textContent.match(/\\d+/)?.[0]||2);var chk=document.querySelectorAll('#_pdv_sabores_lista input[type=checkbox]:checked').length;if(chk>=t){alert('Máx. '+t+' sabores');return;}cb.checked=true;el.style.borderColor='#e74c3c';el.style.background='#fff5f5';}else{cb.checked=false;el.style.borderColor='#e5e7eb';el.style.background='';}if(typeof _pdvPizzaAtualizarPreco==='function')_pdvPizzaAtualizarPreco();})(this)">
              <input type="checkbox" value="${s.nome}" style="display:none">
              ${s.img ? `<img src="${s.img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : `<span style="font-size:1.4rem;flex-shrink:0">🍕</span>`}
              <div style="flex:1;min-width:0">
                <div style="font-size:0.88rem;font-weight:600">${s.nome}${tipoBadge}</div>
                ${s.desc ? `<div style="font-size:0.73rem;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.desc}</div>` : ""}
              </div>
              ${precoLbl}
            </label>`;
          })
          .join("")}
      </div>
    </div>`;

    // ── Passo 3: Borda (opcional) — com update de preço ──────────
    if (bordas.length) {
      html += `<div style="margin-bottom:14px">
        <p style="font-size:0.82rem;font-weight:700;color:#e74c3c;margin-bottom:8px">🧀 Borda (opcional):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px" id="_pdv_pizza_borda_grid">
          <label style="border:2px solid #27ae60;background:#f0fff4;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all .15s"
            onclick="this.closest('#_pdv_pizza_borda_grid').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#27ae60';this.style.background='#f0fff4';if(typeof _pdvPizzaAtualizarPreco==='function')_pdvPizzaAtualizarPreco()">
            <input type="radio" name="_pdv_pizza_borda" value="" style="display:none" checked> Sem borda
          </label>
          ${bordas
            .map(
              (b) => `
            <label style="border:2px solid #e5e7eb;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all .15s"
              onclick="this.closest('#_pdv_pizza_borda_grid').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#27ae60';this.style.background='#f0fff4';if(typeof _pdvPizzaAtualizarPreco==='function')_pdvPizzaAtualizarPreco()">
              <input type="radio" name="_pdv_pizza_borda" value="${b.nome}" style="display:none">
              ${b.nome}${b.preco ? ` <span style="color:#e74c3c">+Gs ${b.preco.toLocaleString("es-PY")}</span>` : ""}
            </label>`,
            )
            .join("")}
        </div>
      </div>`;
    }

    html += `<div id="_pdv_pizza_preco_box" style="background:#fff5f5;border:1.5px solid #fca5a5;border-radius:10px;padding:10px 14px;text-align:center;margin-bottom:8px">
      <div style="font-size:0.78rem;color:#888;margin-bottom:2px">★ Prevalece o preço do tipo mais caro entre os sabores</div>
      <div style="font-size:0.8rem;color:#888">Total estimado:</div>
      <div id="_pdv_pizza_preco_val" style="font-size:1.4rem;font-weight:800;color:#e74c3c">Gs —</div>
    </div>`;

    corpo().innerHTML = html;

    // Expõe cfg para uso externo
    window._pdvPizzaCfg = cfg;

    // ── _pdvPizzaAtualizarPreco: igual ao app.js ─────────────────
    // Preço = max(tam.precos[tipo] para cada sabor selecionado) + borda
    window._pdvPizzaAtualizarPreco = function () {
      const tamIdx = parseInt(
        modal.querySelector('input[name="_pdv_pizza_tam"]:checked')?.value ?? 0,
      );
      const tam = cfg.tamanhos?.[tamIdx];
      if (!tam) return;

      // Atualiza label de max sabores
      const maxLbl = modal.querySelector("#_pdv_pizza_maxlabel");
      if (maxLbl) maxLbl.textContent = `(até ${tam.max_sabores || 2})`;

      // Atualiza preço diferencial em cada card de sabor
      const precoMin = _pdvPrecoMin(tam);
      modal.querySelectorAll("#_pdv_sabores_lista label").forEach((lbl) => {
        const tipo = lbl.dataset.tipoSabor || "";
        const precoEste = _pdvPrecoTipo(tam, tipo);
        const diff = precoEste - precoMin;
        const nomeSabor = (
          lbl.querySelector("input[type=checkbox]")?.value || ""
        ).replace(/[^a-zA-Z0-9]/g, "_");
        const el = modal.querySelector(`#_pdv_sp_${nomeSabor}`);
        if (el)
          el.textContent =
            diff > 0 ? `+Gs ${diff.toLocaleString("es-PY")}` : "";
      });

      // Calcula preço: max dos tipos dos sabores selecionados (REGRA DE OURO — igual app.js)
      const saboresSel = [
        ...modal.querySelectorAll(
          "#_pdv_sabores_lista input[type=checkbox]:checked",
        ),
      ].map((c) => c.closest("label")?.dataset.tipoSabor || "");

      let precoBase;
      if (saboresSel.length > 0) {
        precoBase = Math.max(
          ...saboresSel.map((tipo) => _pdvPrecoTipo(tam, tipo)),
        );
      } else {
        precoBase = tam.preco || 0;
      }

      const bordaVal =
        modal.querySelector('input[name="_pdv_pizza_borda"]:checked')?.value ||
        "";
      const bordaPreco = bordaVal
        ? cfg.bordas?.find((b) => b.nome === bordaVal)?.preco || 0
        : 0;

      const el = modal.querySelector("#_pdv_pizza_preco_val");
      if (el)
        el.textContent =
          "Gs " + (precoBase + bordaPreco).toLocaleString("es-PY");
    };

    // Compatibilidade — mantém função de filtro mas delegando para update de preço
    window._pdvPizzaFiltrarSabores = function () {
      _pdvPizzaAtualizarPreco();
    };

    _pdvPizzaAtualizarPreco();
  }

  // ── AÇAÍ ────────────────────────────────────────────────────
  else if (tipo === "acai") {
    let html = "";
    if (cfg.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#7c3aed;margin-bottom:6px">🍇 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${cfg.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#7c3aed" : "#e5e7eb"};border-radius:10px;padding:8px 10px;cursor:pointer;text-align:center;min-width:70px;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#7c3aed';this.style.background='#f5f3ff'">
              <input type="radio" name="_pdv_acai_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.img ? `<img src="${t.img}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;display:block;margin:0 auto 4px" onerror="this.style.display='none'">` : ""}
              <div style="font-weight:700;font-size:0.85rem">${t.nome}</div>
              <div style="font-size:0.75rem;color:#7c3aed;font-weight:600">Gs ${(t.preco || 0).toLocaleString("es-PY")}</div>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (cfg.acompanhamentos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#7c3aed;margin-bottom:6px">🥄 Acompanhamentos:</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
          ${cfg.acompanhamentos
            .map(
              (a) => `
            <label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:7px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;display:flex;align-items:center;gap:6px;transition:all .15s"
              onclick="var cb=this.querySelector('input');cb.checked=!cb.checked;this.style.borderColor=cb.checked?'#7c3aed':'#e5e7eb';this.style.background=cb.checked?'#f5f3ff':''">
              <input type="checkbox" value="${a.nome}" style="display:none">
              ${a.img ? `<img src="${a.img}" style="width:28px;height:28px;border-radius:4px;object-fit:cover" onerror="this.style.display='none'">` : ""}
              ${a.nome} ${a.preco ? `(+Gs ${a.preco.toLocaleString("es-PY")})` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#7c3aed;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#7c3aed';this.style.background='#f5f3ff';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML = html;
  }

  // ── SHAKE ────────────────────────────────────────────────────
  else if (tipo === "shake") {
    const sk = cfg.shake || {};
    let html = "";
    if (sk.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#2980b9;margin-bottom:6px">📐 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${sk.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#2980b9" : "#e5e7eb"};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:0.88rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#2980b9';this.style.background='#e8f4fd'">
              <input type="radio" name="_pdv_shake_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.nome}${t.ml ? ` (${t.ml}ml)` : ""}<br><span style="font-size:0.75rem;color:#2980b9">Gs ${(t.preco || 0).toLocaleString("es-PY")}</span>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (sk.sabores?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#2980b9;margin-bottom:6px">🍓 Sabor:</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:14px">
          ${sk.sabores
            .map(
              (s, i) => `
            <label style="border:2px solid ${i === 0 ? "#2980b9" : "#e5e7eb"};border-radius:10px;padding:8px;cursor:pointer;text-align:center;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#2980b9';this.style.background='#e8f4fd'">
              <input type="radio" name="_pdv_shake_sabor" value="${s.nome}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${s.img ? `<img src="${s.img}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;display:block;margin:0 auto 4px" onerror="this.style.display='none'">` : ""}
              <div style="font-size:0.83rem;font-weight:600">${s.nome}</div>
              ${s.preco ? `<div style="font-size:0.72rem;color:#2980b9">+Gs ${s.preco.toLocaleString("es-PY")}</div>` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    corpo().innerHTML = html;
  }

  // ── SUCO ────────────────────────────────────────────────────
  else if (tipo === "suco") {
    let html = "";
    if (cfg.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#f59e0b;margin-bottom:6px">📐 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${cfg.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#f59e0b" : "#e5e7eb"};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:0.88rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#f59e0b';this.style.background='#fffbeb'">
              <input type="radio" name="_pdv_suco_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.nome}<br><span style="font-size:0.75rem;color:#f59e0b">Gs ${(t.preco || 0).toLocaleString("es-PY")}</span>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#f59e0b;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#f59e0b';this.style.background='#fffbeb';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML = html;
  }

  // ── SORVETE ─────────────────────────────────────────────────
  else if (tipo === "sorvete") {
    let html = "";
    if (cfg.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">🍦 Quantidade de Bolas:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${cfg.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#0ea5e9" : "#e5e7eb"};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:0.88rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#0ea5e9';this.style.background='#f0f9ff'">
              <input type="radio" name="_pdv_sorv_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.nome}<br><span style="font-size:0.75rem;color:#0ea5e9">Gs ${(t.preco || 0).toLocaleString("es-PY")}</span>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (cfg.sabores?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">🎨 Sabores:</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:14px">
          ${cfg.sabores
            .map(
              (s) => `
            <label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:7px;cursor:pointer;text-align:center;transition:all .15s"
              onclick="var cb=this.querySelector('input');cb.checked=!cb.checked;this.style.borderColor=cb.checked?'#0ea5e9':'#e5e7eb';this.style.background=cb.checked?'#f0f9ff':''">
              <input type="checkbox" value="${s.nome}" style="display:none">
              ${s.img ? `<img src="${s.img}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;display:block;margin:0 auto 4px" onerror="this.style.display='none'">` : ""}
              <div style="font-size:0.8rem;font-weight:600">${s.nome}</div>
              ${s.preco ? `<div style="font-size:0.7rem;color:#0ea5e9">+Gs ${s.preco.toLocaleString("es-PY")}</div>` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (cfg.variacoes?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">🍦 Servir em:</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${cfg.variacoes
            .map(
              (v, i) => `
            <label style="border:2px solid ${i === 0 ? "#0ea5e9" : "#e5e7eb"};border-radius:8px;padding:7px 12px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#0ea5e9';this.style.background='#f0f9ff'">
              <input type="radio" name="_pdv_sorv_var" value="${v.nome}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${v.nome} ${v.preco ? `(+Gs ${v.preco.toLocaleString("es-PY")})` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#0ea5e9';this.style.background='#f0f9ff';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML = html;
  }

  // ── MONTÁVEL GENÉRICO ────────────────────────────────────────
  else if (tipo === "montavel") {
    let html = "";
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#e67e22;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              const preco = it.preco || 0;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#e67e22';this.style.background='#fff8f0';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}${preco ? ` (+Gs ${preco.toLocaleString("es-PY")})` : ""}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML =
      html ||
      '<p style="color:#aaa;font-size:0.85rem">Nenhuma etapa configurada.</p>';
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Confirmar seleção do modal de opções PDV ─────────────────────
function _pdvModalConfirmar(cacheKey) {
  const modal = document.getElementById("pdv-opcoes-modal");
  if (!modal) return;
  const produto = window._pdvProdCache[cacheKey];
  if (!produto) return;
  const cfg = produto.montagem_config || {};
  const tipo = cfg.__tipo || "";
  const obs = modal.querySelector("#_pdv-obs-input")?.value?.trim() || "";

  let preco = produto.preco || 0;
  const montagem = [];
  let variacaoLabel = "";

  if (tipo === "variacoes") {
    const idx = parseInt(modal.querySelector('input[name="_pdv_var"]:checked')?.value ?? 0);
    const v = (cfg.variacoes || [])[idx];
    if (v) {
      // Se a variação tem preço próprio (>0), usa ele; senão usa o preço base do produto
      preco = (v.preco_adicional && v.preco_adicional > 0) ? v.preco_adicional : produto.preco;
      variacaoLabel = v.nome;
      variacaoId = v.id;
    }
  } else if (tipo === "pizza") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_pizza_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    const borda =
      modal.querySelector('input[name="_pdv_pizza_borda"]:checked')?.value ||
      "";
    // Coleta sabores com seus tipos (igual ao app.js)
    const saboresSel = [
      ...modal.querySelectorAll(
        "#_pdv_sabores_lista input[type=checkbox]:checked",
      ),
    ].map((c) => ({
      nome: c.value,
      tipo: c.closest("label")?.dataset.tipoSabor || "",
    }));

    if (!saboresSel.length) {
      alert("Escolha pelo menos 1 sabor.");
      return;
    }

    // Preço = max entre os tipos dos sabores selecionados — REGRA DE OURO (igual app.js)
    const _pdvPrecoPorTipo = (tamObj, tipo) => {
      if (!tamObj) return 0;
      const precos = tamObj.precos || {};
      if (tipo && precos[tipo] > 0) return precos[tipo];
      if (tipo) {
        const k = Object.keys(precos).find(
          (k2) => k2.toLowerCase() === (tipo || "").toLowerCase(),
        );
        if (k && precos[k] > 0) return precos[k];
      }
      return tamObj.preco || 0;
    };
    const precostipos = saboresSel.map((s) => _pdvPrecoPorTipo(tam, s.tipo));
    preco =
      precostipos.length > 0 ? Math.max(...precostipos) : tam?.preco || preco;

    const bordaPreco = borda
      ? cfg.bordas?.find((b) => b.nome === borda)?.preco || 0
      : 0;
    preco += bordaPreco;

    variacaoLabel = tam?.nome || "";
    montagem.push("Sabores: " + saboresSel.map((s) => s.nome).join(" / "));
    if (borda) montagem.push("Borda: " + borda);
  } else if (tipo === "shake") {
    const sk = cfg.shake || {};
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_shake_tam"]:checked')?.value ?? 0,
    );
    const tam = (sk.tamanhos || [])[tamIdx];
    const saborSel =
      modal.querySelector('input[name="_pdv_shake_sabor"]:checked')?.value ||
      "";
    const saborObj = sk.sabores?.find((s) => s.nome === saborSel);
    preco = (tam?.preco || preco) + (saborObj?.preco || 0);
    variacaoLabel = tam?.nome || "";
    if (saborSel) montagem.push(saborSel);
  } else if (tipo === "acai") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_acai_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    preco = tam?.preco || preco;
    variacaoLabel = tam?.nome || "";
    modal.querySelectorAll('input[type="checkbox"]:checked').forEach((c) => {
      const nome = c.value;
      const acomp = cfg.acompanhamentos?.find((a) => a.nome === nome);
      if (acomp?.preco) preco += acomp.preco;
      montagem.push(nome);
    });
  } else if (tipo === "suco") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_suco_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    preco = tam?.preco || preco;
    variacaoLabel = tam?.nome || "";
    modal
      .querySelectorAll('input[type="checkbox"]:checked')
      .forEach((c) => montagem.push(c.value));
  } else if (tipo === "sorvete") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_sorv_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    const varSel =
      modal.querySelector('input[name="_pdv_sorv_var"]:checked')?.value || "";
    const varObj = cfg.variacoes?.find((v) => v.nome === varSel);
    preco = (tam?.preco || preco) + (varObj?.preco || 0);
    variacaoLabel = tam?.nome
      ? `${tam.nome}${varSel ? " — " + varSel : ""}`
      : varSel;
    modal.querySelectorAll('input[type="checkbox"]:checked').forEach((c) => {
      const nome = c.value;
      const sabor = cfg.sabores?.find((s) => s.nome === nome);
      if (sabor?.preco) preco += sabor.preco;
      montagem.push(nome);
    });
  } else if (tipo === "montavel") {
    modal.querySelectorAll('input[type="checkbox"]:checked').forEach((c) => {
      const nome = c.value;
      const item = cfg.etapas
        ?.flatMap((e) => e.itens || [])
        .find((it) => (it.nome || it) === nome);
      if (item?.preco) preco += item.preco;
      montagem.push(nome);
    });
  }

  carrinhoPDV.push({
    id: produto.id,
    nome: produto.nome,
    img: produto.imagem_url,
    categoria_slug: produto.categoria_slug || "",
    es_bebida: produto.es_bebida || false,
    preco,
    qtd: 1,
    variacao: variacaoLabel,
    variacao_id: variacaoId,
    montagem,
    obs,
  });
  atualizarCarrinhoPDV();
  modal.remove();

  if (_deveMostrarExtrasGlobais(produto)) {
    _getExtrasGlobais().then((extras) => {
      if (extras?.length > 0) _mostrarUpsellExtrasPDV(produto, extras);
    });
  }
}
let _toledoPort = null; // Web Serial: porta da balança Toledo

function _mostrarModalPesoPDV(produto, precoKg) {
  document.getElementById("pdv-kg-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "pdv-kg-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:20px;padding:24px 20px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.35)";

  // Formata peso digitado: trata como gramas, exibe "300g" ou "1,230 kg"
  function formatarPeso(gramas) {
    if (!gramas || gramas <= 0) return "";
    if (gramas < 1000) return gramas + "g";
    const kg = (gramas / 1000).toFixed(3).replace(/\.?0+$/, "");
    return kg.replace(".", ",") + " kg";
  }

  function calcularPreco(gramas) {
    return Math.round((precoKg * gramas) / 1000);
  }

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <div>
        <div style="font-size:1rem;font-weight:800;color:#0891b2">⚖️ ${produto.nome}</div>
        <div style="font-size:0.8rem;color:#888;margin-top:2px">Gs ${precoKg.toLocaleString("es-PY")} / kg</div>
      </div>
      <button id="_kg-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#999;line-height:1">✕</button>
    </div>

    <!-- Display de peso -->
    <div style="background:#f0fdfe;border:2px solid #a5f3fc;border-radius:14px;padding:16px;text-align:center;margin-bottom:14px">
      <div style="font-size:2.6rem;font-weight:800;color:#0891b2;letter-spacing:-1px;line-height:1" id="_kg-display-peso">—</div>
      <div style="font-size:0.78rem;color:#0e7490;margin-top:4px">Peso</div>
    </div>

    <!-- Input gramas -->
    <div style="margin-bottom:12px">
      <label style="font-size:0.8rem;font-weight:700;color:#555;display:block;margin-bottom:6px">
        Digite o peso em gramas:
      </label>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" id="_kg-input-g" min="1" step="1" placeholder="Ex: 300"
          style="flex:1;font-size:1.5rem;font-weight:700;padding:10px 14px;border:2px solid #0891b2;border-radius:10px;text-align:center;color:#0891b2;outline:none"
          oninput="_kgAtualizarPreview()" onkeydown="if(event.key==='Enter')_kgConfirmar()">
        <span style="font-size:1rem;font-weight:700;color:#888;white-space:nowrap">g</span>
      </div>
      <div style="font-size:0.73rem;color:#888;margin-top:4px;text-align:center">
        Acima de 1000g é convertido automaticamente para kg
      </div>
    </div>

    <!-- Preview preço -->
    <div id="_kg-preview-preco" style="background:#f0fdf4;border:2px solid #bbf7d0;border-radius:12px;padding:12px 16px;margin-bottom:16px;display:none">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:0.85rem;color:#166534">Total a cobrar:</span>
        <span id="_kg-preco-val" style="font-size:1.5rem;font-weight:800;color:#16a34a">Gs 0</span>
      </div>
      <div id="_kg-peso-formatado" style="font-size:0.75rem;color:#4ade80;text-align:right;margin-top:2px"></div>
    </div>

    <!-- Botão balança Toledo -->
    <button id="_kg-btn-balanca" onclick="_kgConectarBalanca()"
      style="width:100%;padding:10px;background:#fff;border:2px dashed #0891b2;border-radius:10px;color:#0891b2;font-weight:700;font-size:0.85rem;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;justify-content:center;gap:8px">
      🔌 <span id="_kg-balanca-txt">Conectar Balança (Toledo Prix 3)</span>
    </button>

    <!-- Confirmar -->
    <button id="_kg-btn-ok" onclick="_kgConfirmar()"
      disabled
      style="width:100%;padding:14px;background:#0891b2;color:#fff;border:none;border-radius:12px;font-size:1rem;font-weight:800;cursor:pointer;opacity:0.5;transition:all 0.2s">
      ✅ Adicionar ao Pedido
    </button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector("#_kg-close").onclick = () => overlay.remove();

  // Se balança já conectada → inicia leitura automática
  if (_toledoPort) {
    const btnBal = document.getElementById("_kg-btn-balanca");
    const txtBal = document.getElementById("_kg-balanca-txt");
    if (btnBal) {
      btnBal.style.borderStyle = "solid";
      btnBal.style.background = "#e0f7fa";
    }
    if (txtBal)
      txtBal.textContent = "🟢 Balança conectada — aguardando peso...";
    setTimeout(() => _kgIniciarLeituraBalanca(), 100);
  }

  // Funções locais expostas globalmente (escopo do modal)
  window._kgAtualizarPreview = function () {
    const g = parseInt(document.getElementById("_kg-input-g")?.value) || 0;
    const displayPeso = document.getElementById("_kg-display-peso");
    const previewBox = document.getElementById("_kg-preview-preco");
    const precoVal = document.getElementById("_kg-preco-val");
    const pesoFmt = document.getElementById("_kg-peso-formatado");
    const btnOk = document.getElementById("_kg-btn-ok");

    if (g > 0) {
      const fmt = formatarPeso(g);
      const preco = calcularPreco(g);
      if (displayPeso) displayPeso.textContent = fmt;
      if (precoVal)
        precoVal.textContent = `Gs ${preco.toLocaleString("es-PY")}`;
      if (pesoFmt)
        pesoFmt.textContent = `${g}g = ${fmt} × Gs ${precoKg.toLocaleString("es-PY")}/kg`;
      if (previewBox) previewBox.style.display = "block";
      if (btnOk) {
        btnOk.disabled = false;
        btnOk.style.opacity = "1";
      }
    } else {
      if (displayPeso) displayPeso.textContent = "—";
      if (previewBox) previewBox.style.display = "none";
      if (btnOk) {
        btnOk.disabled = true;
        btnOk.style.opacity = "0.5";
      }
    }
  };

  window._kgConfirmar = function () {
    const g = parseInt(document.getElementById("_kg-input-g")?.value) || 0;
    if (!g || g <= 0) {
      document.getElementById("_kg-input-g")?.focus();
      return;
    }
    const preco = calcularPreco(g);
    carrinhoPDV.push({
      id: produto.id + "_kg_" + Date.now(),
      produto_id: produto.id,
      nome: produto.nome,
      preco: preco,
      preco_kg: precoKg,
      peso_gramas: g,
      qtd: 1,
      _isKg: true,
      img: produto.imagem_url || "",
      categoria_slug: produto.categoria_slug || "",
      es_bebida: produto.es_bebida || false,
      montagem: [],
      obs: "",
      variacao_id: null
    });
    atualizarCarrinhoPDV();
    overlay.remove();
  };

  window._kgConectarBalanca = async function () {
    const btn = document.getElementById("_kg-btn-balanca");
    const txt = document.getElementById("_kg-balanca-txt");

    // Web Serial API check
    if (!navigator.serial) {
      alert(
        "⚠️ Web Serial API não suportada neste navegador.\nUse Google Chrome ou Edge para conectar a balança.",
      );
      return;
    }

    // Se porta já conectada, desconectar
    if (_toledoPort) {
      try {
        await _toledoPort.close();
      } catch (_) {}
      _toledoPort = null;
      if (txt) txt.textContent = "Conectar Balança (Toledo Prix 3)";
      if (btn) btn.style.background = "#fff";
      return;
    }

    try {
      if (txt) txt.textContent = "⏳ Aguardando seleção da porta...";
      const port = await navigator.serial.requestPort();
      await port.open({
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
      });
      _toledoPort = port;
      if (txt)
        txt.textContent = "🟢 Balança conectada — Pressione PRINT na balança";
      if (btn) {
        btn.style.background = "#ecfdf5";
        btn.style.borderColor = "#16a34a";
        btn.style.color = "#16a34a";
      }

      // Leitura contínua
      const reader = port.readable.getReader();
      let buffer = "";

      const lerDados = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);

            // Protocolo Toledo Prix 3 Fit: envia linha ao pressionar PRINT
            // Formatos possíveis:
            //   "  0.300 kg\r\n"  →  300g
            //   " 1.230 kg\r\n"   →  1230g
            //   "P  0.300\r\n"    →  variação com prefixo P
            //   "ST,GS,+  0.300kg\r\n"  → formato contínuo
            if (buffer.includes("\n") || buffer.includes("\r")) {
              const linhas = buffer.split(/[\r\n]+/);
              buffer = linhas.pop() || ""; // mantém fragmento incompleto

              for (const linha of linhas) {
                const limpa = linha.trim();
                if (!limpa) continue;

                // Extrai número de kg: procura padrão X.XXX ou X,XXX seguido de "kg" (opcional)
                const match =
                  limpa.match(/([\d]+[.,][\d]{1,3})\s*kg?/i) ||
                  limpa.match(/[STPG,\s]*([\d]+[.,][\d]{1,3})/);

                if (match) {
                  const kgStr = match[1].replace(",", ".");
                  const kgVal = parseFloat(kgStr);
                  if (!isNaN(kgVal) && kgVal > 0) {
                    const gramas = Math.round(kgVal * 1000);
                    // Preenche input e atualiza preview
                    const inp = document.getElementById("_kg-input-g");
                    if (inp) {
                      inp.value = gramas;
                      window._kgAtualizarPreview();
                      // Flash visual de confirmação
                      inp.style.borderColor = "#16a34a";
                      inp.style.background = "#f0fdf4";
                      setTimeout(() => {
                        if (inp) {
                          inp.style.borderColor = "#0891b2";
                          inp.style.background = "";
                        }
                      }, 1200);
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          if (_toledoPort) {
            if (txt) txt.textContent = "🔴 Balança desconectada";
            if (btn) {
              btn.style.background = "#fff";
              btn.style.borderColor = "#0891b2";
              btn.style.color = "#0891b2";
            }
            _toledoPort = null;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch (_) {}
        }
      };

      lerDados();
    } catch (e) {
      if (txt) txt.textContent = "Conectar Balança (Toledo Prix 3)";
      if (e.name !== "NotFoundError") {
        console.error("Erro balança:", e);
      }
    }
  };

  // Foca no input após render
  setTimeout(() => document.getElementById("_kg-input-g")?.focus(), 100);
}

window._pdvProdCache = {};

function _mostrarModalVariacaoPDV(produto, variacoes) {
  document.getElementById("pdv-var-modal")?.remove();

  // Guarda produto no cache por ID
  const cacheKey = "pdv_" + (produto.id || Date.now());
  window._pdvProdCache[cacheKey] = produto;

  const overlay = document.createElement("div");
  overlay.id = "pdv-var-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:16px;padding:20px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:16px";
  header.innerHTML = `
    <h4 style="margin:0;font-size:1rem;color:#333">🎨 Escolha a variação</h4>
    <button id="_pdv-var-close" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>`;
  modal.appendChild(header);
  modal.querySelector("#_pdv-var-close").onclick = () => overlay.remove();

  const nomeProd = document.createElement("p");
  nomeProd.style.cssText = "font-size:0.88rem;color:#666;margin-bottom:14px";
  nomeProd.textContent = produto.nome;
  modal.appendChild(nomeProd);

  const lista = document.createElement("div");
  lista.style.cssText = "display:flex;flex-direction:column;gap:10px";

  variacoes.forEach((v) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText =
      "display:flex;align-items:center;gap:12px;background:#f9f9f9;border:2px solid #e5e7eb;border-radius:10px;padding:10px 14px;cursor:pointer;text-align:left;transition:border-color 0.15s;width:100%";
    btn.onmouseover = () => {
      btn.style.borderColor = "var(--primary)";
    };
    btn.onmouseout = () => {
      btn.style.borderColor = "#e5e7eb";
    };

    const imgSrc = v.img || produto.imagem_url;
    btn.innerHTML = `
      ${imgSrc ? `<img src="${imgSrc}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : ""}
      <div style="flex:1">
        <div style="font-weight:700;font-size:0.9rem;color:#333">${v.nome}</div>
        <div style="font-size:0.82rem;color:var(--primary);font-weight:600">Gs ${(v.preco || produto.preco || 0).toLocaleString("es-PY")}</div>
      </div>`;

    btn.onclick = () => {
      const p = window._pdvProdCache[cacheKey];
      if (!p) return;
      const existe = carrinhoPDV.find(
        (i) => i.id === p.id && i.variacao === v.nome,
      );
      if (existe) {
        existe.qtd++;
      } else {
        carrinhoPDV.push({
          id: p.id,
          nome: p.nome,
          img: p.imagem_url,
          categoria_slug: p.categoria_slug || "",
          es_bebida: p.es_bebida || false,
          preco: v.preco || p.preco || 0,
          qtd: 1,
          variacao: v.nome,
          variacao_id: v.id || null,
          montagem: [],
          obs: "",
        });
      }
      atualizarCarrinhoPDV();
      overlay.remove();
    };
    lista.appendChild(btn);
  });

  modal.appendChild(lista);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Toast de upsell de extras globais ─────────────────────────────
function _mostrarUpsellExtrasPDV(produto, extras) {
  // Remove toast anterior se ainda estiver aberto
  document.getElementById("pdv-upsell-toast")?.remove();

  const toast = document.createElement("div");
  toast.id = "pdv-upsell-toast";
  toast.style.cssText = [
    "position:fixed;bottom:20px;right:16px;z-index:99998",
    "background:#fff;border-radius:14px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.18)",
    "padding:0;max-width:300px;width:calc(100vw - 32px)",
    "border:1px solid #f0f0f0",
    "animation:_upsellIn 0.25s cubic-bezier(.4,0,.2,1)",
    "overflow:hidden",
  ].join(";");

  if (!document.getElementById("_upsell-style")) {
    const s = document.createElement("style");
    s.id = "_upsell-style";
    s.textContent = `
      @keyframes _upsellIn{from{transform:translateY(20px) scale(.96);opacity:0}to{transform:none;opacity:1}}
      #pdv-upsell-toast .ue-btn:hover{filter:brightness(0.92)}
    `;
    document.head.appendChild(s);
  }

  // Header
  const hdr = document.createElement("div");
  hdr.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;padding:12px 14px 10px;border-bottom:1px solid #f5f5f5;background:var(--color-background-secondary)";

  // Pega o último item do carrinho que corresponde a este produto (para mostrar a variação)
  const ultimoItem = [...carrinhoPDV]
    .reverse()
    .find((i) => i.id === produto.id);
  const subtitleTxt = ultimoItem?.variacao
    ? `${produto.nome} — ${ultimoItem.variacao}`
    : produto.nome;

  hdr.innerHTML = `
    <div>
      <div style="font-weight:700;font-size:0.85rem;color:var(--color-text-primary)">➕ Adicionar ao pedido?</div>
      <div style="font-size:0.73rem;color:var(--color-text-secondary);margin-top:1px">${subtitleTxt}</div>
    </div>`;
  const btnX = document.createElement("button");
  btnX.textContent = "✕";
  btnX.style.cssText =
    "background:none;border:none;font-size:1rem;cursor:pointer;color:#bbb;padding:4px 6px;border-radius:6px;flex-shrink:0";
  btnX.addEventListener("click", () => toast.remove());
  hdr.appendChild(btnX);
  toast.appendChild(hdr);

  // Lista de extras
  const lista = document.createElement("div");
  lista.style.cssText = "padding:6px 0";
  extras.forEach((extra) => {
    if (!extra.nome) return;
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;justify-content:space-between;align-items:center;padding:7px 14px;transition:background .1s";
    row.onmouseenter = () => (row.style.background = "#fafafa");
    row.onmouseleave = () => (row.style.background = "");

    const info = document.createElement("div");
    info.innerHTML = `
      <div style="font-size:0.83rem;font-weight:600;color:#333">${extra.nome}</div>
      <div style="font-size:0.73rem;color:var(--primary,#FF441F);font-weight:700">+ Gs ${(extra.preco || 0).toLocaleString("es-PY")}</div>`;

    const btn = document.createElement("button");
    btn.className = "ue-btn";
    btn.style.cssText =
      "background:var(--primary,#FF441F);color:#fff;border:none;border-radius:8px;padding:5px 13px;font-size:0.78rem;cursor:pointer;font-weight:700;transition:all .15s;white-space:nowrap;flex-shrink:0";
    btn.textContent = "+ Add";
    btn.addEventListener("click", () => {
      const nomeExtra = extra.nome;
      const existe = carrinhoPDV.find(
        (i) => i._isExtra && i.nome === nomeExtra,
      );
      if (existe) {
        existe.qtd++;
      } else {
        carrinhoPDV.push({
          id: "ext_" + Date.now(),
          nome: nomeExtra,
          preco: extra.preco || 0,
          qtd: 1,
          _isExtra: true,
          variacao_id: null
        });
      }
      atualizarCarrinhoPDV();
      btn.textContent = "✓";
      btn.style.background = "#27ae60";
      btn.disabled = true;
      row.style.opacity = "0.6";
    });

    row.appendChild(info);
    row.appendChild(btn);
    lista.appendChild(row);
  });
  toast.appendChild(lista);

  document.body.appendChild(toast);
  // Auto-fecha em 10 s
  setTimeout(() => {
    if (document.getElementById("pdv-upsell-toast") === toast) toast.remove();
  }, 10000);
}

function removerItemPDV(idx) {
  carrinhoPDV.splice(idx, 1);
  atualizarCarrinhoPDV();
}

function limparCarrinhoPDV() {
  if (carrinhoPDV.length === 0 && !window._mesaAbertaId) return;
  if (!confirm("Cancelar a venda e limpar o carrinho?")) return;

  carrinhoPDV = [];
  window._mesaAbertaId = null;
  window._mesaAbertaPedido = null;

  const ids = {
    "balcao-cliente": "",
    "balcao-mesa": "",
    "balcao-telefone": "",
    "balcao-endereco": "",
    "balcao-geo-lat": "",
    "balcao-geo-lng": "",
    "balcao-frete": "",
    "pdv-desconto-val": "",
    "pdv-recebido": "",
  };
  Object.entries(ids).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  // Mesma correção do reset pós-venda: limpa também a seleção de
  // cliente "Na Nota" (busca + ID interno), senão ela fica "pré-carregada"
  // (só visualmente) para a próxima venda.
  _pdvClienteSelecionadoId = null;
  const clienteBuscaElLimpar = document.getElementById("pdv-cliente-busca");
  if (clienteBuscaElLimpar) clienteBuscaElLimpar.value = "";
  const clienteNotaContainerLimpar = document.getElementById("pdv-cliente-nota-container");
  if (clienteNotaContainerLimpar) clienteNotaContainerLimpar.style.display = "none";

  const selPag = document.getElementById("balcao-pag");
  if (selPag) {
    selPag.value = "Efetivo";
    selPag.style.display = "";
  }
  const selTipo = document.getElementById("balcao-tipo-entrega");
  if (selTipo) selTipo.value = "balcao";
  const descTipo = document.getElementById("pdv-desconto-tipo");
  if (descTipo) descTipo.value = "fixo";

  const trocoEl = document.getElementById("pdv-troco-val");
  if (trocoEl) trocoEl.textContent = "0";
  const freteMsgEl = document.getElementById("frete-msg-pdv");
  if (freteMsgEl) freteMsgEl.innerHTML = "";

  [
    "pdv-delivery-row",
    "box-multi-pdv",
    "pdv-cashback-box",
    "pdv-row-troco",
    "pdv-row-recebido",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  const toggleEl = document.getElementById("pdv-toggle-delivery");
  if (toggleEl) toggleEl.classList.remove("active");
  const chipEl = document.getElementById("pdv-tipo-chip");
  if (chipEl) chipEl.textContent = "🏪 Balcão";

  const multiPartes = document.getElementById("multi-partes-pdv");
  if (multiPartes) multiPartes.innerHTML = "";
  if (typeof _multiContadorPDV !== "undefined") _multiContadorPDV = 0;

  _pdvCashbackDisponivel = 0;
  _pdvCashbackUsando = false;

  atualizarCarrinhoPDV();
  _pdvToast("🗑️ Carrinho limpo.");
}

function pdvAlterarQtd(idx, delta) {
  const item = carrinhoPDV[idx];
  if (!item) return;
  item.qtd = Math.max(1, (item.qtd || 1) + delta);
  atualizarCarrinhoPDV();
}

function pdvEditarItem(idx) {
  const item = carrinhoPDV[idx];
  if (!item) return;
  // Reabre o modal de opções para o produto, preservando o índice para substituição
  window._pdvEditandoIdx = idx;
  adicionarItemPDV({ ...item, _editando: true });
}

function atualizarCarrinhoPDV() {
  const lista = document.getElementById("pdv-lista");
  const totalEl = document.getElementById("balcao-total");
  if (!lista) return;

  lista.innerHTML = "";
  let total = 0;

  // ── Itens existentes da mesa (snapshot do DB) ──────────────────
  const itensExistentes = window._mesaAbertaPedido
    ? Array.isArray(window._mesaAbertaPedido.itens)
      ? window._mesaAbertaPedido.itens
      : []
    : [];

  if (itensExistentes.length > 0) {
    const secTitle = document.createElement("tr");
    secTitle.innerHTML =
      '<td colspan="4" class="pdv-sec-title">Itens já lançados</td>';
    lista.appendChild(secTitle);

    itensExistentes.forEach((item, idx) => {
      const entregue = item.status_item === "entregue";
      const qtd = item.qtd || item.q || 1;
      const nome = item.nome || item.n || "Item";
      const preco = item.preco || item.p || 0;
      total += preco * qtd;

      const row = document.createElement("tr");
      row.className = "pdv-item-existente" + (entregue ? " pdv-item-entregue" : "");
      row.innerHTML = `
        <td colspan="4" class="pdv-item-card">
          <div class="pdv-item-card-header">
            <span class="pdv-item-card-nome">${nome}${entregue ? ' <span class="badge-entregue">✓</span>' : ""}</span>
            <span class="pdv-item-card-total" style="${entregue ? "color:#888" : ""}">Gs ${(preco * qtd).toLocaleString("es-PY")}</span>
          </div>
          <div class="pdv-item-card-sub">Gs ${preco.toLocaleString("es-PY")} / un. · ${qtd}x${entregue ? " · <em style='color:#27ae60;font-weight:700'>✓ Entregue</em>" : ""}</div>
          ${!entregue ? `
          <div class="pdv-item-card-acoes">
            <button class="pdv-item-card-excluir" style="background:#e8f5e9;color:#27ae60;border-color:#86efac" title="Baixar item" onclick="baixarItemMesa(${window._mesaAbertaId},${idx})">
              <i class="fas fa-check"></i> Baixar
            </button>
          </div>` : ""}
        </td>`;
      lista.appendChild(row);
    });
  }

  // ── Novos itens sendo adicionados (carrinhoPDV) ────────────────
  if (carrinhoPDV.length > 0) {
    const secTitle2 = document.createElement("tr");
    secTitle2.innerHTML = `<td colspan="4" class="pdv-sec-title pdv-sec-novo">${itensExistentes.length > 0 ? "+ Novos itens" : "Itens do pedido"}</td>`;
    lista.appendChild(secTitle2);

    carrinhoPDV.forEach((item, idx) => {
      total += item.preco * item.qtd;
      const row = document.createElement("tr");

      if (item._isKg) {
        // Item por peso: layout compacto com remove
        const g = item.peso_gramas || 0;
        const pesofmt =
          g >= 1000
            ? (g / 1000)
                .toFixed(3)
                .replace(/\.?0+$/, "")
                .replace(".", ",") + "kg"
            : g + "g";
        row.innerHTML = `
          <td colspan="4" class="pdv-item-card">
            <div class="pdv-item-card-header">
              <span class="pdv-item-card-nome">⚖️ ${pesofmt} — ${item.nome}</span>
              <span class="pdv-item-card-total">Gs ${item.preco.toLocaleString("es-PY")}</span>
            </div>
            <div class="pdv-item-card-acoes">
              <button class="pdv-item-card-excluir" onclick="removerItemPDV(${idx})">
                <i class="fas fa-trash"></i> Excluir
              </button>
            </div>
          </td>`;
      } else {
        // Item normal: card com preço unitário, controles de qtd, Editar e Excluir
        const temMontagem = item.montagem?.length > 0 || item.obs;
        row.innerHTML = `
          <td colspan="4" class="pdv-item-card">
            <div class="pdv-item-card-header">
              <span class="pdv-item-card-nome">${item.nome}</span>
              <span class="pdv-item-card-total">Gs ${(item.preco * item.qtd).toLocaleString("es-PY")}</span>
            </div>
            <div class="pdv-item-card-sub">Gs ${item.preco.toLocaleString("es-PY")} / un.</div>
            ${item.obs ? `<div class="pdv-item-card-obs">📝 ${item.obs}</div>` : ""}
            <div class="pdv-item-card-acoes">
              <div class="pdv-item-card-qtd">
                <button class="pdv-qtd-btn" onclick="pdvAlterarQtd(${idx}, -1)">−</button>
                <span class="pdv-qtd-val">${item.qtd}</span>
                <button class="pdv-qtd-btn" onclick="pdvAlterarQtd(${idx}, +1)">+</button>
              </div>
              ${temMontagem ? `<button class="pdv-item-card-editar" onclick="pdvEditarItem(${idx})"><i class="fas fa-pencil-alt"></i> Editar</button>` : ""}
              <button class="pdv-item-card-excluir" onclick="removerItemPDV(${idx})">
                <i class="fas fa-trash"></i> Excluir
              </button>
            </div>
          </td>`;
      }
      lista.appendChild(row);
    });
  }

  if (itensExistentes.length === 0 && carrinhoPDV.length === 0) {
    lista.innerHTML =
      '<tr><td colspan="4" class="pdv-lista-vazio">Nenhum item adicionado.</td></tr>';
  }

  if (totalEl) totalEl.innerText = total.toLocaleString("es-PY");

  // ── Desconto ──────────────────────────────────────────────────
  const descTipo =
    document.getElementById("pdv-desconto-tipo")?.value || "fixo";
  const descValRaw =
    parseFloat(document.getElementById("pdv-desconto-val")?.value || "0") || 0;
  let desconto = 0;
  if (descValRaw > 0) {
    desconto =
      descTipo === "percentual"
        ? Math.round((total * descValRaw) / 100)
        : Math.round(descValRaw);
    desconto = Math.min(desconto, total);
  }
  const totalComDesc = total - desconto;

  // Atualiza subtotal
  const subEl = document.getElementById("balcao-subtotal");
  if (subEl) subEl.innerText = total.toLocaleString("es-PY");

  // Linha de desconto
  const rowDesc = document.getElementById("pdv-row-desconto");
  const descEl = document.getElementById("balcao-desconto");
  if (rowDesc) rowDesc.style.display = desconto > 0 ? "flex" : "none";
  if (descEl) descEl.innerText = desconto.toLocaleString("es-PY");

  // Total final
  if (totalEl) totalEl.innerText = totalComDesc.toLocaleString("es-PY");

  // Frete (delivery)
  const frete =
    parseInt(document.getElementById("balcao-frete")?.value || "0") || 0;
  const tipoEntrega =
    document.getElementById("balcao-tipo-entrega")?.value || "balcao";
  let totalFinal = totalComDesc + (tipoEntrega === "delivery" ? frete : 0);

  // Cashback (calculado APÓS soma total dos itens)
  const cashDesc = pdvGetCashbackDesconto(totalFinal);
  if (cashDesc > 0) totalFinal = Math.max(0, totalFinal - cashDesc);
  const elCash = document.getElementById("pdv-row-cashback");
  if (elCash) {
    elCash.style.display = cashDesc > 0 ? "flex" : "none";
    const elCashVal = document.getElementById("balcao-cashback");
    if (elCashVal) elCashVal.textContent = cashDesc.toLocaleString("es-PY");
  }

  if (totalEl) totalEl.innerText = totalFinal.toLocaleString("es-PY");

  // Atualiza barra inferior mobile
  const mobileQtd = document.getElementById("pdv-mobile-qtd");
  const mobileTot = document.getElementById("pdv-mobile-total-val");
  const qtdTotal = carrinhoPDV.reduce((a, i) => a + i.qtd, 0);
  if (mobileQtd)
    mobileQtd.textContent = qtdTotal + (qtdTotal === 1 ? " item" : " itens");
  if (mobileTot) mobileTot.textContent = totalFinal.toLocaleString("es-PY");

  // Troco / Vuelta — recalcula ao mudar carrinho
  _pdvAtualizarTroco(totalFinal);

  atualizarInfoPagPDV(totalFinal);
}

function _pdvAtualizarTroco(totalFinal) {
  const pag = document.getElementById("balcao-pag")?.value;
  const recebidoEl = document.getElementById("pdv-recebido");
  const trocoEl = document.getElementById("pdv-troco-val");
  const trocoRow = document.getElementById("pdv-row-troco");
  const recebRow = document.getElementById("pdv-row-recebido");
  if (!recebidoEl || !trocoEl) return;

  const isEfetivo = pag === "Efetivo";
  if (recebRow) recebRow.style.display = isEfetivo ? "flex" : "none";
  if (trocoRow) trocoRow.style.display = isEfetivo ? "flex" : "none";

  if (!isEfetivo) return;
  const recebido = parseInt((recebidoEl.value || "0").replace(/\D/g, "")) || 0;
  const troco = recebido > totalFinal ? recebido - totalFinal : 0;
  trocoEl.textContent = troco.toLocaleString("es-PY");
  trocoEl.style.color = troco > 0 ? "#16a34a" : "#888";
}

function atualizarInfoPagPDV(total) {
  const pag = document.getElementById("balcao-pag")?.value;
  const infoBox = document.getElementById("balcao-pag-info");
  const boxMultiPDV = document.getElementById("box-multi-pdv");
  const selectPag = document.getElementById("balcao-pag");
  if (!infoBox) return;

  // Mostra/oculta campo Recebido + Troco conforme forma de pagamento
  _pdvAtualizarTroco(total);

  infoBox.style.display = "none";
  if (boxMultiPDV) boxMultiPDV.style.display = "none";
  if (selectPag) selectPag.style.display = "";

  if (pag === "CartaoBR" && total > 0) {
    infoBox.style.display = "block";
    const _renderCarBR = () => {
      const taxa =
        _cartaoBRTipoPDV === "debito" ? _taxaDebitoPDV : _taxaCreditoPDV;
      const brl =
        _cotacaoPDV > 0
          ? ((total / _cotacaoPDV) * (1 + taxa / 100)).toFixed(2)
          : "---";
      infoBox.innerHTML = `
        <div style="font-size:0.78rem;font-weight:700;margin-bottom:6px">💳🇧🇷 Cartão Brasileiro</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button type="button" onclick="_setPDVBRTipo('debito')"
            style="flex:1;padding:6px 4px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.75rem;
                   border:2px solid ${_cartaoBRTipoPDV === "debito" ? "#1a7a2e" : "#ccc"};
                   background:${_cartaoBRTipoPDV === "debito" ? "#eafaf1" : "#f8f9fa"};
                   color:${_cartaoBRTipoPDV === "debito" ? "#1a7a2e" : "#555"}">
            Débito<br><small>${_taxaDebitoPDV.toFixed(2)}%</small></button>
          <button type="button" onclick="_setPDVBRTipo('credito')"
            style="flex:1;padding:6px 4px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.75rem;
                   border:2px solid ${_cartaoBRTipoPDV === "credito" ? "#1a7a2e" : "#ccc"};
                   background:${_cartaoBRTipoPDV === "credito" ? "#eafaf1" : "#f8f9fa"};
                   color:${_cartaoBRTipoPDV === "credito" ? "#1a7a2e" : "#555"}">
            Crédito<br><small>${_taxaCreditoPDV.toFixed(2)}%</small></button>
        </div>
        <div style="text-align:center;font-size:1rem;font-weight:900;color:#1a7a2e">R$ ${brl}</div>`;
    };
    window._setPDVBRTipo = (tipo) => {
      _cartaoBRTipoPDV = tipo;
      _renderCarBR();
    };
    window._renderCarBRPDV = _renderCarBR;
    _renderCarBR();
  } else if (pag === "Pix" && total > 0) {
    const valorReais = (total / _cotacaoPDV).toFixed(2);
    infoBox.style.display = "block";
    infoBox.innerHTML = `<i class="fas fa-qrcode"></i> <strong>Cobrar em Pix: R$ ${valorReais}</strong>`;
  } else if (pag === "Multipagamento") {
    if (selectPag) selectPag.style.display = "none";
    if (boxMultiPDV) {
      boxMultiPDV.style.display = "block";
      const partesEl = document.getElementById("multi-partes-pdv");
      if (partesEl && partesEl.children.length === 0) {
        adicionarPartePagamentoPDV();
        adicionarPartePagamentoPDV();
      }
      atualizarRestanteMultiPDV();
    }
  }
}

// ── MULTIPAGAMENTO PDV ─────────────────────────────────────────────
let _multiContadorPDV = 0;

function voltarPagamentoPDVUnico() {
  document.getElementById("balcao-pag").value = "Efetivo";
  document.getElementById("box-multi-pdv").style.display = "none";
  document.getElementById("multi-partes-pdv").innerHTML = "";
  document.getElementById("balcao-pag").style.display = "";
  _multiContadorPDV = 0;
  atualizarInfoPagPDV(
    parseInt(
      document.getElementById("balcao-total").innerText.replace(/\D/g, ""),
    ) || 0,
  );
}

function adicionarPartePagamentoPDV() {
  const container = document.getElementById("multi-partes-pdv");
  if (!container) return;
  _multiContadorPDV++;
  const id = _multiContadorPDV;
  const ordinal = ["1ª", "2ª", "3ª", "4ª", "5ª"][id - 1] || `${id}ª`;
  const opts = [
    { v: "Efetivo", l: "💵 Efectivo" },
    { v: "Cartao", l: "💳 Tarjeta" },
    { v: "CartaoBR", l: "💳🇧🇷 Cartão BR" },
    { v: "Pix", l: "🟢 Pix" },
    { v: "Transferencia", l: "🏦 Alias" },
    { v: "QrPy", l: "📱 QR Paraguay" },
  ]
    .map((m) => `<option value="${m.v}">${m.l}</option>`)
    .join("");

  const card = document.createElement("div");
  card.id = `multi-parte-pdv-${id}`;
  card.style.cssText =
    "background:white;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px;margin-bottom:8px";
  card.innerHTML = `
    <div style="font-size:0.72rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${ordinal} FORMA</div>
    <div style="display:flex;gap:8px;align-items:center">
      <select id="multi-metodo-pdv-${id}" onchange="atualizarRestanteMultiPDV()"
          style="flex:1.5;padding:8px;border:1.5px solid #e0e0e0;border-radius:7px;font-size:0.85rem;background:white;font-weight:600">
        <option value="">Selecionar...</option>${opts}
      </select>
      <div style="flex:1;position:relative">
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#888;font-size:0.8rem;pointer-events:none">Gs</span>
        <input type="number" id="multi-valor-pdv-${id}" placeholder="0" min="0" step="1000"
            data-touched="0"
            oninput="this.dataset.touched='1'; atualizarRestanteMultiPDV()"
            style="width:100%;padding:8px 8px 8px 28px;border:1.5px solid #e0e0e0;border-radius:7px;font-size:0.9rem;font-weight:700;box-sizing:border-box">
      </div>
      ${
        id > 2
          ? `<button type="button" onclick="removerPartePDV(${id})"
          style="background:#ffeaea;color:#e74c3c;border:none;padding:8px 10px;border-radius:7px;cursor:pointer;flex-shrink:0">✕</button>`
          : ""
      }
    </div>`;
  container.appendChild(card);
  atualizarRestanteMultiPDV();
}

function removerPartePDV(id) {
  document.getElementById(`multi-parte-pdv-${id}`)?.remove();
  atualizarRestanteMultiPDV();
}

function atualizarRestanteMultiPDV() {
  const total = parseInt(
    document.getElementById("balcao-total")?.innerText.replace(/\D/g, "") ||
      "0",
  );
  const inputs = [...document.querySelectorAll('[id^="multi-valor-pdv-"]')];
  let soma = 0;
  inputs.forEach((inp) => {
    soma += parseFloat(inp.value) || 0;
  });

  // Auto-fill: se exatamente 1 input vazio e sobra valor
  const vazios = inputs.filter(
    (inp) => !inp.value || parseFloat(inp.value) === 0,
  );
  if (vazios.length === 1 && total - soma > 0) {
    vazios[0].value = total - soma;
    soma = total;
  }

  const bar = document.getElementById("multi-status-pdv");
  const el = document.getElementById("multi-restante-pdv");
  if (!el || !bar) return;
  bar.style.display = "block";

  const diff = total - soma;
  if (Math.abs(diff) < 1) {
    bar.style.background = "#eafaf1";
    bar.style.borderColor = "#27ae60";
    el.innerHTML = `<span style="color:#27ae60">✅ Total coberto: Gs ${total.toLocaleString("es-PY")}</span>`;
  } else if (diff > 0) {
    bar.style.background = "#fff8e6";
    bar.style.borderColor = "#f0a500";
    el.innerHTML = `<span style="color:#e67e22">⚠️ Faltam: Gs ${diff.toLocaleString("es-PY")}</span>`;
  } else {
    bar.style.background = "#fdf3f3";
    bar.style.borderColor = "#e74c3c";
    el.innerHTML = `<span style="color:#e74c3c">❌ Excede: Gs ${Math.abs(diff).toLocaleString("es-PY")}</span>`;
  }
}

function _coletarMultiPagamentoPDV() {
  const partes = [];
  document.querySelectorAll('[id^="multi-parte-pdv-"]').forEach((div) => {
    const idStr = div.id.replace("multi-parte-pdv-", "");
    const metodo =
      document.getElementById(`multi-metodo-pdv-${idStr}`)?.value || "";
    const valor =
      parseFloat(document.getElementById(`multi-valor-pdv-${idStr}`)?.value) ||
      0;
    if (metodo && valor > 0) partes.push({ metodo, valor });
  });
  return partes;
}

// ── trava anti-duplo-clique do PDV ─────────────────────────────────────
let _pdvEnviando = false;

async function salvarPedidoBalcao() {
  if (_pdvEnviando) return; // bloqueia duplo-clique
  _pdvEnviando = true;

  // Feedback visual imediato no botão
  const _btnLancar = document.querySelector(".pdv-btn-lancar");
  const _txtOrigBtn = _btnLancar ? _btnLancar.innerHTML : "";
  if (_btnLancar) {
    _btnLancar.disabled = true;
    _btnLancar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processando...';
    _btnLancar.style.opacity = "0.65";
  }
  const _liberarPDV = () => {
    _pdvEnviando = false;
    if (_btnLancar) {
      _btnLancar.disabled = false;
      _btnLancar.innerHTML = _txtOrigBtn;
      _btnLancar.style.opacity = "1";
    }
  };
  // Segurança: libera em 30s mesmo se algo travar
  const _timerPDV = setTimeout(_liberarPDV, 30000);

  // Envolve o corpo da função em try/finally para garantir liberação
  try {

  if (carrinhoPDV.length === 0 && !window._mesaAbertaId) {
    alert(t("alert.carrinho_vazio"));
    return;
  }
  if (carrinhoPDV.length === 0 && window._mesaAbertaId) {
    alert("Adicione ao menos 1 novo item antes de lançar.");
    return;
  }

  const _soKg = carrinhoPDV.length > 0 && carrinhoPDV.every((i) => i._isKg);

  // const mesaInput = document.getElementById("balcao-mesa");
  //   if (mesaInput) mesaInput.value = "";

  const mesaEl = document.getElementById("balcao-mesa");
  const clienteEl = document.getElementById("balcao-cliente");
  const telefoneEl = document.getElementById("balcao-telefone");
  const pagEl = document.getElementById("balcao-pag");

  const cli = clienteEl?.value?.trim() || "Cliente";
  const tel = telefoneEl?.value?.trim() || "";
  const pag = pagEl?.value || "Efetivo";
  const mesa = "";
  const pagFinalPDV =
    pag === "CartaoBR"
      ? _cartaoBRTipoPDV === "debito"
        ? "Cartão BR - Débito"
        : "Cartão BR - Crédito"
      : pag;

  const nomeFinal = mesa
    ? `MESA ${mesa} - ${cliente}`
    : _soKg
      ? `BALCÃO KG - ${cli}`
      : `BALCÃO - ${cli}`;

  // ── Desconto manual ──────────────────────────────────────────
  const descTipo =
    document.getElementById("pdv-desconto-tipo")?.value || "fixo";
  const descValRaw =
    parseFloat(document.getElementById("pdv-desconto-val")?.value || "0") || 0;
  const subtotalBruto = carrinhoPDV.reduce(
    (a, i) => a + (i.preco || 0) * (i.qtd || 1),
    0,
  );
  let descontoAplicado = 0;
  if (descValRaw > 0) {
    descontoAplicado =
      descTipo === "percentual"
        ? Math.round((subtotalBruto * descValRaw) / 100)
        : Math.round(descValRaw);
    descontoAplicado = Math.min(descontoAplicado, subtotalBruto); // não pode ser maior que o total
  }

  // ── Tratamento Multipagamento ────────────────────────────────
  let obsPagPDV = "Pagamento no Balcão";
  if (pag === "Multipagamento") {
    const partesPDV = _coletarMultiPagamentoPDV();
    if (partesPDV.length === 0) {
      alert("Adicione ao menos 1 forma de pagamento!");
      return;
    }
    const totalPedido = parseInt(
      document.getElementById("balcao-total")?.innerText.replace(/\D/g, "") ||
        "0",
    );
    const somaPartes = partesPDV.reduce((a, p) => a + p.valor, 0);
    if (Math.abs(somaPartes - totalPedido) > 1) {
      alert(
        `⚠️ Total das formas (Gs ${somaPartes.toLocaleString("es-PY")}) não bate com o total do pedido (Gs ${totalPedido.toLocaleString("es-PY")}).`,
      );
      return;
    }
    obsPagPDV = JSON.stringify(partesPDV);
  }

  // ── Novos itens ganham status_item: 'pendente' ─────────────────
  const novosItens = carrinhoPDV.map((i) => ({
  produto_id: i.produto_id || i.id,
  id: i.id || Date.now() + Math.random(),
  nome: i.nome,
  preco: i.preco,
  qtd: i.qtd,
  montagem: i.montagem || [],
  obs: i.obs || "",
  categoria_slug: i.categoria_slug || "",
  es_bebida: i.es_bebida || false,
  ...(i._isKg ? { peso_gramas: i.peso_gramas, preco_kg: i.preco_kg, _isKg: true } : {}),
  variacao_id: i.variacao_id || null,
  variacao: i.variacao || "",   // ← ADICIONE ESTA LINHA
  status_item: "pendente",
  lancado_em: new Date().toISOString(),
}));

  if (window._mesaAbertaId) {
    // ── UPDATE: mantém itens existentes (com seus status_item atuais)
    //           e acrescenta apenas os novos itens pendentes ──────────
    const itensExistentes = Array.isArray(window._mesaAbertaPedido?.itens)
      ? window._mesaAbertaPedido.itens
      : [];

    const itensMerged = [...itensExistentes, ...novosItens];
    // Itens kg: preco já é o total pesado (preco_kg × peso), não multiplicar por qtd
    const novoTotal = itensMerged.reduce(
      (acc, i) =>
        acc + (i._isKg ? i.preco || 0 : (i.preco || 0) * (i.qtd || 1)),
      0,
    );

    const { error } = await supa
      .from("pedidos")
      .update({
        itens: itensMerged,
        total_geral: novoTotal,
        subtotal: novoTotal,
        forma_pagamento: pagFinalPDV,
        obs_pagamento: obsPagPDV,
        cliente_nome: nomeFinal,
        cliente_telefone: tel,
        status: "em_preparo",
      })
      .eq("id", window._mesaAbertaId);

    if (error) {
      alert("Erro ao atualizar mesa: " + error.message);
      return;
    }
    // Descontar estoque dos novos itens adicionados
    await _descontarEstoqueVendaItens(novosItens);
    // Marca a flag para manter rastreabilidade e evitar duplo desconto
    // (ex: se este pedido depois passar por mudarStatus('em_preparo'))
    await supa
      .from("pedidos")
      .update({ estoque_descontado: true })
      .eq("id", window._mesaAbertaId);

    // Reset
    window._mesaAbertaId = null;
    window._mesaAbertaTotal = 0;
    window._mesaAbertaPedido = null;
    carrinhoPDV = [];
    document.getElementById("balcao-cliente").value = "";
    document.getElementById("balcao-mesa").value = "";
    document.getElementById("balcao-telefone").value = "";
    document.querySelector(".pdv-mesa-aviso")?.remove();
    atualizarCarrinhoPDV();
    atualizarBarraMesasAtivas();
    carregarMonitorMesas();
    alert(`✅ ${novosItens.length} item(s) enviado(s) para separação!`);
    return;
  }

  // ── INSERT: novo pedido de balcão ─────────────────────────────
  const tipoEntregaPDV =
    document.getElementById("balcao-tipo-entrega")?.value || "balcao";
  const fretePDV =
    tipoEntregaPDV === "delivery"
      ? parseInt(document.getElementById("balcao-frete")?.value || "0") || 0
      : 0;
  const enderecoPDV =
    tipoEntregaPDV === "delivery"
      ? document.getElementById("balcao-endereco")?.value.trim() || "Delivery"
      : mesa
        ? `Mesa ${mesa}`
        : _soKg
          ? "Balcão - Venda Kg"
          : "Balcão";

  const _geoLat = document.getElementById("balcao-geo-lat")?.value || null;
  const _geoLng = document.getElementById("balcao-geo-lng")?.value || null;

  const subtotalLiquido = subtotalBruto - descontoAplicado;
  const totalNovo = subtotalLiquido + fretePDV;
  const _agora = new Date().toISOString();
  // ── Lógica de status inicial ───────────────────────────────────
  // PDV delivery: precisa passar por preparo → em_preparo (ou pronto se todos sem cozinha)
  // PDV balcão / mesa / retirada: cliente já comprou e saiu → entregue direto
  const _isPdvDelivery = tipoEntregaPDV === "delivery";
  const _statusInicial = _isPdvDelivery
    ? (_todosSemCozinha(carrinhoPDV) ? "pronto_entrega" : "em_preparo")
    : "entregue"; // balcão/mesa/retirada: venda concluída na hora

  // Timestamps: delivery recebe só os tempos iniciais; balcão fecha todos de uma vez
  const _tsDelivery = _isPdvDelivery ? {} : {
    tempo_pronto:    _agora,
    tempo_entregue:  _agora,
  };

  // ── Chave de idempotência do PDV ────────────────────────────────────
  // Protege contra inserts duplicados quando o operador clica várias vezes
  // (rede lenta, F5 no meio do envio, etc). Hash determinístico do carrinho
  // + cliente + minuto atual: se o MESMO carrinho for enviado de novo dentro
  // da mesma janela de 1 minuto, o backend recusa o segundo insert.
  const _hashCarrinhoPDV = novosItens
    .map((i) => `${i.id}-${i.qtd}-${i.preco}`)
    .sort()
    .join("|");
  const _pdvIdempKey = `pdv-${_hashCarrinhoPDV}-${tel || cli}-${Math.floor(Date.now() / 60000)}`;

  // Verifica no banco se já existe um pedido idêntico nos últimos 60s
  const { data: _pedidoExistente } = await supa
    .from("pedidos")
    .select("id")
    .eq("idempotency_key", _pdvIdempKey)
    .maybeSingle();

  if (_pedidoExistente) {
    console.warn(`[PDV] Envio duplicado bloqueado — pedido já existe: #${_pedidoExistente.id}`);
    alert(`⚠️ Esta venda já foi registrada (Pedido #${_pedidoExistente.id}). Evite clicar várias vezes.`);
    carrinhoPDV = [];
    atualizarCarrinhoPDV();
    return;
  }

  const pedido = {
    uid_temporal: `BALC-${Math.floor(Math.random() * 1000)}`,
    idempotency_key: _pdvIdempKey,
    status: _soKg ? "entregue" : _statusInicial,
    tipo_entrega: tipoEntregaPDV,
    subtotal: subtotalBruto,
    desconto_pdv_valor: descontoAplicado,
    desconto_pdv_tipo: descontoAplicado > 0 ? descTipo : null,
    frete_cobrado_cliente: fretePDV,
    total_geral: totalNovo,
    forma_pagamento: pag,
    itens: novosItens,
    endereco_entrega: enderecoPDV,
    cliente_nome: nomeFinal,
    cliente_telefone: tel,
    obs_pagamento: obsPagPDV,
    garcom_id: _perfilId || null,
    garcom_nome: _perfilNome || null,
    ...(tipoEntregaPDV === "delivery" && _geoLat && _geoLng
      ? { geo_lat: _geoLat, geo_lng: _geoLng }
      : {}),
    tempo_recebido:          _agora,
    tempo_confirmado:        _agora,
    tempo_preparo_iniciado:  _isPdvDelivery ? _agora : null,
    ..._tsDelivery,
    ...(_soKg ? { tempo_pronto: _agora, tempo_entregue: _agora } : {}),
    // PDV já desconta o estoque logo após o insert; marca para evitar duplo desconto
    estoque_descontado: true,
  };

  if (pag === 'NaNota') {
  const nomeCliente = document.getElementById('balcao-cliente')?.value?.trim();
  const telCliente = document.getElementById('balcao-telefone')?.value?.trim();
  if (_pdvClienteSelecionadoId) {
    pedido.cliente_id = _pdvClienteSelecionadoId;
  } else if (nomeCliente && telCliente) {
    // Tenta buscar ou criar
    const { data: existing } = await supa
      .from('clientes')
      .select('id')
      .eq('telefone', telCliente)
      .maybeSingle();
    if (existing) {
      pedido.cliente_id = existing.id;
      _pdvClienteSelecionadoId = existing.id;
    } else {
      const { data: novo, error } = await supa
        .from('clientes')
        .insert([{ nome: nomeCliente, telefone: telCliente, cashback_saldo: 0, total_gasto: 0 }])
        .select('id')
        .single();
      if (!error && novo) {
        pedido.cliente_id = novo.id;
        _pdvClienteSelecionadoId = novo.id;
        // Atualiza cache
        _pdvClientesCache.push({ id: novo.id, nome: nomeCliente, telefone: telCliente });
      }
    }
  }
}

  const { data: novoPedido, error } = await supa
    .from("pedidos")
    .insert([pedido])
    .select("id")
    .single();
  if (error) {
    // Se o erro for de chave duplicada (unique constraint), é uma tentativa
    // de duplo-envio que passou pela checagem acima por race condition —
    // trata como sucesso silencioso em vez de erro confuso pro operador.
    if (error.code === "23505" || /duplicate key/i.test(error.message || "")) {
      alert("⚠️ Esta venda já estava sendo processada. Verifique a lista de pedidos antes de tentar novamente.");
      carrinhoPDV = [];
      atualizarCarrinhoPDV();
      return;
    }
    alert("Erro: " + error.message);
    return;
  }
  // Descontar estoque imediatamente (PDV não passa por mudarStatus)
  if (novoPedido?.id) await _descontarEstoqueVenda(novoPedido.id, novosItens);

  if (_pdvCashbackUsando && tel) {
    const descCash = pdvGetCashbackDesconto(totalNovo);
    if (descCash > 0) await crmUsarCashback(tel, descCash);
    _pdvCashbackUsando = false;
    _pdvCashbackDisponivel = 0;
    document.getElementById("pdv-cashback-box").style.display = "none";
  }

  // ── Cashback: gerar crédito pela nova compra ──────────────────
  if (tel) {
    await crmGerarCashback(tel, totalNovo, novoPedido?.id || null);
  }

  // ── Impressão automática ───────────────────────────────────────
  if (novoPedido?.id) {
    // Monta dados direto (sem segunda busca no banco)
    const dadosImpressao = {
      id: novoPedido.id,
      cliente: { nome: nomeFinal, tel: tel },
      entrega: { tipo: "balcao", ref: pedido.endereco_entrega },
      itens: novosItens.map((i) => ({
        q: i.qtd || 1,
        n: i.nome,
        p: i.preco,
        t: i.variacao || "",
        pr: i.preparo || "",
        m: i.montagem || [],
        o: i.obs || "",
        peso_gramas: i.peso_gramas,
        _isKg: i._isKg,
      })),
      valores: {
        sub: subtotalBruto,
        desconto: descontoAplicado,
        frete: fretePDV,
        total: totalNovo,
      },
      pagamento: { metodo: pag, obs: obsPagPDV },
      data: new Date().toLocaleString("pt-BR"),
    };
    const base64 = btoa(
      unescape(encodeURIComponent(JSON.stringify(dadosImpressao))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    window.open(
      `imprimir.html?d=${base64}`,
      "PrintPDV",
      "width=400,height=600",
    );
  }

  carrinhoPDV = [];
  document.getElementById("balcao-cliente").value = "";
  const mesaInput = document.getElementById("balcao-mesa");
  if (mesaInput) mesaInput.value = "";
  document.getElementById("balcao-telefone").value = "";
  // ⚠️ CORREÇÃO: o cliente selecionado para "Na Nota" (busca + ID interno)
  // não estava sendo limpo aqui. Isso fazia o próximo pedido "Na Nota"
  // aparecer com um cliente "pré-carregado" (só visualmente, no campo de
  // busca) enquanto os campos reais (balcao-cliente/telefone) já estavam
  // vazios — o pedido saía com nome genérico "Cliente" só no texto, mas
  // ainda podia gravar cliente_id do cliente ANTERIOR (_pdvClienteSelecionadoId
  // nunca era resetado), colando a dívida na conta errada.
  _pdvClienteSelecionadoId = null;
  const clienteBuscaEl = document.getElementById("pdv-cliente-busca");
  if (clienteBuscaEl) clienteBuscaEl.value = "";
  const clienteNotaContainer = document.getElementById("pdv-cliente-nota-container");
  if (clienteNotaContainer) clienteNotaContainer.style.display = "none";
  // Reset tipo entrega e campos de delivery
  const tipoSelPDV = document.getElementById("balcao-tipo-entrega");
  if (tipoSelPDV) tipoSelPDV.value = "balcao";
  const endPDV = document.getElementById("balcao-endereco");
  if (endPDV) endPDV.value = "";
  const geoPDVLat = document.getElementById("balcao-geo-lat");
  if (geoPDVLat) geoPDVLat.value = "";
  const geoPDVLng = document.getElementById("balcao-geo-lng");
  if (geoPDVLng) geoPDVLng.value = "";
  const fretePDVInput = document.getElementById("balcao-frete");
  if (fretePDVInput) fretePDVInput.value = "";
  const freteMsgPDV = document.getElementById("frete-msg-pdv");
  if (freteMsgPDV) freteMsgPDV.innerHTML = "";
  const deliveryRowPDV = document.getElementById("pdv-delivery-row");
  if (deliveryRowPDV) deliveryRowPDV.style.display = "none";
  // Reset visual do toggle delivery
  const toggleDelivEl = document.getElementById("pdv-toggle-delivery");
  if (toggleDelivEl) toggleDelivEl.classList.remove("active");
  const chipEl = document.getElementById("pdv-tipo-chip");
  if (chipEl) chipEl.textContent = "🏪 Balcão";
  const descValEl = document.getElementById("pdv-desconto-val");
  if (descValEl) descValEl.value = "";
  const descTipoEl = document.getElementById("pdv-desconto-tipo");
  if (descTipoEl) descTipoEl.value = "fixo";
  // Reset recebido / troco
  const recebidoEl = document.getElementById("pdv-recebido");
  if (recebidoEl) recebidoEl.value = "";
  const trocoEl = document.getElementById("pdv-troco-val");
  if (trocoEl) trocoEl.textContent = "0";
  // Reset cashback
  _pdvCashbackDisponivel = 0;
  _pdvCashbackUsando = false;
  const cashBox = document.getElementById("pdv-cashback-box");
  if (cashBox) cashBox.style.display = "none";
  // Reset multipagamento PDV
  const multiPartesPDV = document.getElementById("multi-partes-pdv");
  if (multiPartesPDV) multiPartesPDV.innerHTML = "";
  _multiContadorPDV = 0;
  document.getElementById("balcao-pag").value = "Efetivo";
  document.getElementById("balcao-pag").style.display = "";
  const boxMultiPDV = document.getElementById("box-multi-pdv");
  if (boxMultiPDV) boxMultiPDV.style.display = "none";
  atualizarCarrinhoPDV();
  atualizarBarraMesasAtivas();
  carregarMonitorMesas();
  // Toast não-bloqueante (alert segurava o popup de impressão)
  const _msgFinal = _soKg
    ? "✅ Venda registrada!"
    : _todosBebidas(novosItens)
      ? "✅ Só bebidas — direto ao balcão."
      : "✅ Enviado para separação!";
  _pdvToast(_msgFinal);

  } finally {
    clearTimeout(_timerPDV);
    _liberarPDV();
  }
}

// ── Toast não-bloqueante do PDV ───────────────────────────────
function _pdvToast(msg, duracao = 3000) {
  document.getElementById("_pdv-toast")?.remove();
  const t = document.createElement("div");
  t.id = "_pdv-toast";
  t.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a7a2e;color:#fff;padding:12px 28px;border-radius:30px;font-size:1rem;font-weight:700;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.25);pointer-events:none;animation:_toastIn 0.2s ease";
  t.textContent = msg;
  if (!document.getElementById("_pdv-toast-style")) {
    const s = document.createElement("style");
    s.id = "_pdv-toast-style";
    s.textContent =
      "@keyframes _toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}";
    document.head.appendChild(s);
  }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duracao);
}

// ── Barra de Mesas Ativas no PDV ─────────────────────────────
async function atualizarBarraMesasAtivas() {
  const bar = document.getElementById("pdv-mesas-bar");
  const vazio = document.getElementById("pdv-mesas-vazio");
  if (!bar) return;

  const { data } = await supa
    .from("pedidos")
    .select("id, endereco_entrega, cliente_nome, total_geral, status, itens")
    .eq("tipo_entrega", "balcao")
    .neq("status", "entregue")
    .neq("status", "cancelado")
    .order("id", { ascending: true });

  // Limpar chips anteriores (manter apenas label e span vazio)
  bar.querySelectorAll(".mesa-chip").forEach((c) => c.remove());
  if (vazio) vazio.style.display = data && data.length > 0 ? "none" : "inline";

  if (!data || data.length === 0) return;

  data.forEach((p) => {
    const nrMesa = (p.endereco_entrega || "").replace("Mesa ", "") || p.id;
    const chip = document.createElement("button");
    chip.className =
      "mesa-chip" +
      (p.status === "pronto_entrega"
        ? " mesa-pronto"
        : p.status === "em_preparo"
          ? " mesa-em-preparo"
          : "");
    chip.title = `${p.cliente_nome || "Mesa " + nrMesa} — Gs ${(p.total_geral || 0).toLocaleString("es-PY")} — Clique para adicionar itens`;
    chip.innerHTML = `<span class="mesa-chip-num">${nrMesa}</span><span class="mesa-chip-status">${
      p.status === "pronto_entrega"
        ? "✓ Pronto"
        : p.status === "em_preparo"
          ? "🔥"
          : "●"
    }</span>`;
    chip.onclick = () => abrirMesaExistente(p);
    bar.appendChild(chip);
  });
}

// Abre uma mesa existente no carrinho PDV para adicionar mais itens
function abrirMesaExistente(pedido) {
  const nrMesa = (pedido.endereco_entrega || "").replace("Mesa ", "") || "";
  const nomeCli = (pedido.cliente_nome || "").replace(/^MESA \d+ - /i, "");

  // Preenche os campos
  const elMesa = document.getElementById("balcao-mesa");
  const elCli = document.getElementById("balcao-cliente");
  if (elMesa) elMesa.value = nrMesa;
  if (elCli) elCli.value = nomeCli === "Cliente" ? "" : nomeCli;

  // ──────────────────────────────────────────────────────────────────
  // MUDANÇA: carrinhoPDV fica VAZIO — só recebe os NOVOS itens.
  // Os itens existentes ficam em window._mesaAbertaPedido (snapshot do DB).
  // Na hora do save, fazemos merge: existentes (intactos) + novos (pendente).
  // ──────────────────────────────────────────────────────────────────
  carrinhoPDV = [];
  window._mesaAbertaId = pedido.id;
  window._mesaAbertaTotal = pedido.total_geral || 0;
  window._mesaAbertaPedido = pedido; // guarda snapshot completo

  atualizarCarrinhoPDV();

  // Scroll para o topo do PDV
  const pdv = document.getElementById("pdv");
  if (pdv) pdv.scrollIntoView({ behavior: "smooth", block: "start" });

  // Aviso visual
  const aviso = document.createElement("div");
  aviso.className = "pdv-mesa-aviso";
  aviso.innerHTML = `<i class="fas fa-edit"></i> Editando Mesa ${nrMesa} — adicione os NOVOS itens e clique em Lançar`;
  const existing = pdv?.querySelector(".pdv-mesa-aviso");
  if (existing) existing.remove();
  const h4 = pdv?.querySelector(".pdv-carrinho-titulo");
  if (h4) h4.after(aviso);
  setTimeout(() => aviso?.remove(), 8000);
}

async function carregarMonitorMesas() {
  // Atualiza barra de chips de mesas no PDV junto com o monitor
  atualizarBarraMesasAtivas();
  // Busca pedidos de Balcão que NÃO foram finalizados (entregues)
  const { data } = await supa
    .from("pedidos")
    .select("*")
    .eq("tipo_entrega", "balcao")
    .neq("status", "entregue") // Traz 'pendente', 'em_preparo' e 'pronto_entrega'
    .order("id", { ascending: false });

  const div = document.getElementById("lista-mesas-andamento");
  if (!div) return;

  div.innerHTML = "";

  if (!data || data.length === 0) {
    div.innerHTML = '<p class="mesa-monitor-vazio">Nenhum pedido ativo.</p>';
    return;
  }

  data.forEach((p) => {
    let statusHtml = "";
    let acaoHtml = "";
    let cardClass = "mesa-monitor-card";

    // Lógica Visual do Status — usa classes CSS
    if (p.status === "em_preparo") {
      cardClass += " mesa-preparo";
      statusHtml =
        '<span class="mesa-monitor-status-cozinha"><i class="fas fa-fire"></i> Em Separação</span>';
      acaoHtml =
        '<small class="mesa-monitor-status-cozinha">Aguardando Separação...</small>';
    } else if (p.status === "pronto_entrega") {
      cardClass += " mesa-pronta";
      statusHtml =
        '<span class="mesa-monitor-status-pronto"><i class="fas fa-check-circle"></i> PRONTO!</span>';
      acaoHtml = `<button class="btn btn-sm btn-success btn-block-pdv" onclick="finalizarMesa(${p.id})">Entregar / Baixar</button>`;
    } else {
      statusHtml = `<span class="mesa-monitor-valor">${p.status}</span>`;
    }

    const nrMesa =
      (p.endereco_entrega || "").replace("Mesa ", "") || p.uid_temporal || p.id;

    // Lista de itens com status visual por item
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const pendentes = itens.filter(
      (i) => !i.status_item || i.status_item === "pendente",
    );
    const entregues = itens.filter((i) => i.status_item === "entregue");

    let itensListHtml = itens
      .map((item, idx) => {
        const isEntregue = item.status_item === "entregue";
        const nome = item.nome || item.n || "Item";
        const qtd = item.qtd || item.q || 1;
        return `
        <div class="monitor-item-row ${isEntregue ? "monitor-item-entregue" : ""}">
          <span class="monitor-item-nome">${qtd}x ${nome}</span>
          ${
            isEntregue
              ? '<span class="monitor-item-badge-entregue">✓ Entregue</span>'
              : `<button class="btn btn-xs btn-outline-success monitor-btn-baixar"
                title="Marcar como entregue"
                onclick="baixarItemMesa(${p.id}, ${idx})">
                <i class="fas fa-check"></i>
               </button>`
          }
        </div>`;
      })
      .join("");

    // Contador de pendentes no cabeçalho
    const cntPendente =
      pendentes.length > 0
        ? `<span class="mesa-monitor-cnt-pendente">${pendentes.length} pendente${pendentes.length > 1 ? "s" : ""}</span>`
        : "";

    const card = document.createElement("div");
    card.className = cardClass;
    card.innerHTML = `
      <div class="mesa-monitor-titulo">Mesa ${nrMesa} ${cntPendente}</div>
      <div class="mesa-monitor-cliente">${p.cliente_nome || "-"}</div>
      <div class="mesa-monitor-itens-lista">${itensListHtml}</div>
      <div class="mesa-monitor-rodape">
        ${statusHtml}
        <span class="mesa-monitor-valor">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</span>
      </div>
      ${acaoHtml}
    `;
    div.appendChild(card);
  });
}

// ── Baixa parcial: marca 1 item como 'entregue' no banco ──────────
// idx = índice do item dentro do array p.itens no banco
async function baixarItemMesa(pedidoId, itemIdx) {
  // Busca snapshot mais recente do banco (evita conflito de estado stale)
  const { data: p, error: errFetch } = await supa
    .from("pedidos")
    .select("itens, total_geral")
    .eq("id", pedidoId)
    .single();
  if (errFetch || !p) {
    alert("Erro ao buscar comanda.");
    return;
  }

  const itens = Array.isArray(p.itens) ? [...p.itens] : [];
  if (!itens[itemIdx]) return;

  // Muda status do item específico
  itens[itemIdx] = { ...itens[itemIdx], status_item: "entregue" };

  const { error } = await supa
    .from("pedidos")
    .update({ itens })
    .eq("id", pedidoId);

  if (error) {
    alert("Erro ao baixar item: " + error.message);
    return;
  }

  // Atualiza o snapshot local e re-renderiza o carrinho PDV
  if (window._mesaAbertaPedido && window._mesaAbertaId === pedidoId) {
    window._mesaAbertaPedido = { ...window._mesaAbertaPedido, itens };
    atualizarCarrinhoPDV();
  }
  // Atualiza o monitor de mesas sem precisar recarregar tudo
  atualizarBarraMesasAtivas();
}

// Função para dar baixa na mesa (Muda status para 'entregue' e sai da lista)
async function finalizarMesa(id) {
  if (confirm("Confirmar entrega e pagamento desta mesa?")) {
    // Busca pedido para checar se estoque já foi descontado (PDV balcao desconta na criação)
    const { data: pedAtual } = await supa
      .from("pedidos")
      .select("estoque_descontado")
      .eq("id", id)
      .single();

    await supa
      .from("pedidos")
      .update({
        status: "entregue",
        tempo_entregue: new Date().toISOString(),
        estoque_descontado: true,
      })
      .eq("id", id);

    // Desconta estoque apenas se ainda não foi descontado
    // PDV balcão desconta em salvarPedidoBalcao(); demais pedidos balcão descontam aqui
    if (!pedAtual?.estoque_descontado) {
      await _descontarEstoqueVenda(id, null);
    }

    carregarMonitorMesas();
    if (typeof calcularFinanceiro === "function") calcularFinanceiro();
    const abaAtual = localStorage.getItem("app_lastTab");
    if (abaAtual === "pedidos") carregarPedidos();
  }
}

// Utilitários de Modal e Checkbox
function fecharModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
  }
}

function toggleTodos(s) {
  document
    .querySelectorAll(".check-pedido")
    .forEach((c) => (c.checked = s.checked));
}

// Clique fora do modal fecha
window.onclick = function (event) {
  if (event.target.classList.contains("modal-overlay")) {
    event.target.classList.remove("active");
    event.target.style.display = "none";
  }
};

// ESC fecha modal
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    document
      .querySelectorAll('.modal-overlay.active, .modal-overlay[style*="flex"]')
      .forEach((modal) => {
        modal.classList.remove("active");
        modal.style.display = "none";
      });
  }
});

// =========================================
// 10. GESTÃO DE EQUIPE
// =========================================
async function carregarEquipe() {
  const { data } = await supa.from("perfis_acesso").select("*").order("cargo");

  const tbody = document.getElementById("lista-equipe");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (data) {
    data.forEach((u) => {
      const dataCriacao = u.created_at
        ? new Date(u.created_at).toLocaleDateString("pt-BR")
        : "-";
      const ehDono = u.cargo === "dono";
      const ehGerente = u.cargo === "gerente";
      const ehFuncionario = u.cargo === "funcionario";
      const ehGarcom = u.cargo === "garcom";
      const ehAM = u.cargo === "adminMaster";

      // Botão de promoção/rebaixamento
      let acaoCargo = "";
      if (
        !ehAM &&
        (perfilUsuario === "dono" || perfilUsuario === "adminMaster")
      ) {
        if (ehFuncionario || ehGarcom) {
          acaoCargo = `<button class="btn btn-sm btn-success" onclick="promoverUsuario('${u.id}', 'gerente')" title="Promover a Gerente"><i class="fas fa-arrow-up"></i> Gerente</button>`;
        } else if (ehGerente) {
          acaoCargo = `<button class="btn btn-sm btn-warning" onclick="promoverUsuario('${u.id}', 'funcionario')" title="Rebaixar a Funcionário"><i class="fas fa-arrow-down"></i> Funcionário</button>`;
        }
        if (perfilUsuario === "adminMaster" && !ehDono) {
          acaoCargo += ` <button class="btn btn-sm btn-primary" onclick="promoverUsuario('${u.id}', 'dono')" title="Tornar Dono"><i class="fas fa-crown"></i> Dono</button>`;
        }
        if (!ehDono) {
          acaoCargo += ` <button class="btn btn-sm btn-danger" onclick="excluirUsuario('${u.id}', '${u.email}')" title="Excluir"><i class="fas fa-trash"></i></button>`;
        }
      }
      // Botão de permissões individuais — só o Admin Master edita,
      // e não faz sentido restringir outro Admin Master.
      let acaoPermissoes = "";
      if (perfilUsuario === "adminMaster" && !ehAM) {
        const nomeSeguro = (u.nome_display || u.email || "").replace(/'/g, "\\'");
        acaoPermissoes = ` <button class="btn btn-sm btn-secondary" onclick="abrirPermissoesUsuario('${u.id}', '${nomeSeguro}')" title="Permissões individuais"><i class="fas fa-key"></i> Permissões</button>`;
      }

      const cargoBadge = ehAM
        ? "🎮 Admin Master"
        : ehDono
          ? "🔑 Dono"
          : ehGerente
            ? "👔 Gerente"
            : ehGarcom
              ? "🍽️ Garçom"
              : "👷 Funcionário";
      tbody.innerHTML += `<tr>
                <td><strong>${u.nome_display || "—"}</strong></td>
                <td>${u.email}</td>
                <td>${cargoBadge}</td>
                <td>${dataCriacao}</td>
                <td>${acaoCargo}${acaoPermissoes}</td>
            </tr>`;
    });
  }
}

async function promoverUsuario(id, novoCargo) {
  const msg =
    novoCargo === "gerente"
      ? "Promover este usuário a Gerente?"
      : "Rebaixar este usuário a Funcionário?";
  if (!confirm(msg)) return;

  const { error } = await supa
    .from("perfis_acesso")
    .update({ cargo: novoCargo })
    .eq("id", id);
  if (error) {
    alert("❌ Erro: " + error.message);
  } else {
    alert(`✅ Cargo alterado para ${novoCargo}!`);
    carregarEquipe();
  }
}

async function excluirUsuario(id, email) {
  if (
    !confirm(
      `⚠️ Excluir o usuário "${email}"?\n\nEsta ação remove apenas o perfil. O acesso de autenticação pode precisar ser revogado no Supabase Dashboard.`,
    )
  )
    return;

  const { error } = await supa.from("perfis_acesso").delete().eq("id", id);
  if (error) {
    alert("❌ Erro ao excluir: " + error.message);
  } else {
    alert("✅ Usuário excluído com sucesso!");
    carregarEquipe();
  }
}

/* ══════════════════════════════════════════════════════════════
   PERMISSÕES INDIVIDUAIS POR USUÁRIO
   O Admin Master pode liberar/restringir, para UMA pessoa específica,
   quais abas/tipos de produto/funções/formas de pagamento ela vê —
   sobrepondo o padrão global definido em Configurações > Features.
   Reaproveita as mesmas categorias/checklists desse painel global.
   ══════════════════════════════════════════════════════════════ */

const _PERM_TABS = [
  ["pedidos", "Pedidos"],
  ["cozinha", "Cozinha/KDS"],
  ["pdv", "PDV Balcão"],
  ["financeiro", "Financeiro"],
  ["inventario", "Inventário"],
  ["equipe", "Equipe"],
  ["configuracoes", "Configurações"],
  ["dashboard", "Dashboard"],
  ["turnos", "Painel Turnos/TV"],
  ["notas", "Na Nota (Contas de Clientes)"],
];
const _PERM_FUNCS = [
  ["delivery", "Delivery"],
  ["retirada", "Retirada"],
  ["local", "Comer no Local"],
  ["balcao", "Balcão/PDV"],
  ["cupons", "Cupons"],
  ["factura", "Factura"],
  ["multipagamento", "Multipagamento"],
  ["agendamento", "Agendamento"],
];
const _PERM_PAGS = [
  ["Efetivo", "💵 Efectivo/Dinheiro"],
  ["Cartao", "💳 Tarjeta PY"],
  ["CartaoBR", "💳🇧🇷 Cartão Brasileiro (R$)"],
  ["Pix", "🟢 Pix (BR)"],
  ["Transferencia", "🏦 Alias/Transferência PY"],
  ["QrPy", "📱 QR Paraguay"],
  ["Multipagamento", "🔀 Dividir Pagamento"],
];

function _permChecklistHtml(items, dataAttr, override, globalDefaults) {
  return items
    .map(([k, l]) => {
      // Efetivo = override individual (se definido) > padrão global > true
      const efetivo =
        override && Object.prototype.hasOwnProperty.call(override, k)
          ? override[k] !== false
          : (globalDefaults ? globalDefaults[k] : undefined) !== false;
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
        <input type="checkbox" data-${dataAttr}="${k}" ${efetivo ? "checked" : ""} style="width:18px;height:18px">
        <span>${l}</span></label>`;
    })
    .join("");
}

async function abrirPermissoesUsuario(userId, nomeExibicao) {
  if (perfilUsuario !== "adminMaster") return alert(t("alert.acesso_negado"));

  const { data: usuario, error } = await supa
    .from("perfis_acesso")
    .select("permissoes_customizadas")
    .eq("id", userId)
    .single();
  if (error) return alert("Erro ao carregar permissões: " + error.message);

  await _carregarFeaturesGlobais(); // garante FEATURES_ATIVAS atualizado
  const override = usuario?.permissoes_customizadas || null;
  const g = FEATURES_ATIVAS || {};

  document.getElementById("modal-permissoes-usuario")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "modal-permissoes-usuario";
  overlay.className = "modal-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:16px;padding:22px;max-width:640px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)";

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <h3 style="margin:0;font-size:1.1rem">🔐 Permissões — ${nomeExibicao}</h3>
      <button onclick="document.getElementById('modal-permissoes-usuario').remove()"
        style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>
    </div>
    <p style="font-size:0.82rem;color:#666;margin:0 0 14px">
      ${override ? "⚠️ Este usuário já tem permissões personalizadas — elas têm prioridade sobre o padrão global." : "Este usuário ainda segue o padrão global (Configurações › Features)."}
    </p>

    <div style="margin-bottom:14px">
      <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:6px">📑 Abas</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${_permChecklistHtml(_PERM_TABS, "uperm-tab", override?.tabs, g.tabs)}
      </div>
    </div>

    <div style="margin-bottom:14px">
      <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:6px">⚙️ Funcionalidades</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${_permChecklistHtml(_PERM_FUNCS, "uperm-func", override?.funcionalidades, g.funcionalidades)}
      </div>
    </div>

    <div style="margin-bottom:18px">
      <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:6px">💳 Formas de Pagamento</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${_permChecklistHtml(_PERM_PAGS, "uperm-pag", override?.pagamentos, g.pagamentos)}
      </div>
    </div>

    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" style="flex:2" onclick="salvarPermissoesUsuario('${userId}')">💾 Salvar Permissões</button>
      <button class="btn btn-secondary" style="flex:1" onclick="restaurarPermissoesUsuario('${userId}')">↺ Usar Padrão Global</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function salvarPermissoesUsuario(userId) {
  const modal = document.getElementById("modal-permissoes-usuario");
  if (!modal) return;

  const tabs = {}, funcs = {}, pags = {};
  modal.querySelectorAll("[data-uperm-tab]").forEach((el) => (tabs[el.dataset.upermTab] = el.checked));
  modal.querySelectorAll("[data-uperm-func]").forEach((el) => (funcs[el.dataset.upermFunc] = el.checked));
  modal.querySelectorAll("[data-uperm-pag]").forEach((el) => (pags[el.dataset.upermPag] = el.checked));

  const permissoes = { tabs, funcionalidades: funcs, pagamentos: pags };
  const { error } = await supa
    .from("perfis_acesso")
    .update({ permissoes_customizadas: permissoes })
    .eq("id", userId);
  if (error) return alert("Erro ao salvar: " + error.message);

  alert("✅ Permissões individuais salvas!");
  modal.remove();
}

async function restaurarPermissoesUsuario(userId) {
  if (!confirm("Remover as permissões personalizadas deste usuário e voltar a usar o padrão global?")) return;
  const { error } = await supa
    .from("perfis_acesso")
    .update({ permissoes_customizadas: null })
    .eq("id", userId);
  if (error) return alert("Erro: " + error.message);
  alert("✅ Usuário voltou a usar o padrão global.");
  document.getElementById("modal-permissoes-usuario")?.remove();
}

// ═══════════════════════════════════════════════════════════════
// ADMIN MASTER — CRUD completo de usuários
// ═══════════════════════════════════════════════════════════════

async function amCriarUsuario() {
  if (perfilUsuario !== "adminMaster") return alert(t("alert.acesso_negado"));
  const email = document.getElementById("am-email")?.value?.trim();
  const nome = document.getElementById("am-nome")?.value?.trim();
  const senha = document.getElementById("am-senha")?.value;
  const cargo = document.getElementById("am-cargo")?.value || "dono";
  if (!email || !nome || !senha || senha.length < 6)
    return alert("Preencha email, nome e senha (mín. 6 caracteres).");
  const btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Criando...";
  }
  try {
    const { data, error } = await supa.auth.signUp({ email, password: senha });
    if (error) {
      alert("❌ Erro: " + error.message);
      return;
    }
    if (data.user) {
      const { error: ep } = await supa
        .from("perfis_acesso")
        .upsert([{ id: data.user.id, email, cargo, nome_display: nome }], {
          onConflict: "id",
        });
      if (ep) {
        alert("⚠️ Auth criado mas erro no perfil: " + ep.message);
        return;
      }
      const cargoBadge = {
        dono: "Dono",
        gerente: "Gerente",
        funcionario: "Funcionário",
        garcom: "Garçom",
      };
      alert(
        `✅ Usuário "${nome}" criado como ${cargoBadge[cargo] || cargo}!\nSolicite que confirme o email antes de fazer login.`,
      );
      document.getElementById("am-email").value = "";
      document.getElementById("am-nome").value = "";
      document.getElementById("am-senha").value = "";
      amCarregarUsuarios();
    }
  } catch (e) {
    alert("❌ Erro: " + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-user-plus"></i> Criar Usuário';
    }
  }
}

// Compatibilidade com cadastrarDono (aba Configurações)
async function cadastrarDono() {
  const emailEl = document.getElementById("am-email");
  const cargoEl = document.getElementById("am-cargo");
  if (cargoEl) cargoEl.value = "dono";
  return amCriarUsuario();
}

async function amCarregarUsuarios() {
  if (perfilUsuario !== "adminMaster") return;
  const tbody = document.getElementById("am-lista-usuarios");
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="4" style="text-align:center;padding:16px"><i class="fas fa-spinner fa-spin"></i> Carregando...</td></tr>';

  const { data, error } = await supa
    .from("perfis_acesso")
    .select("*")
    .order("cargo");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:red;text-align:center">${error.message}</td></tr>`;
    return;
  }

  if (!data || !data.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#aaa">Nenhum usuário cadastrado</td></tr>';
    return;
  }

  const cargoBadges = {
    adminMaster:
      '<span style="background:#e74c3c;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">🎮 Admin Master</span>',
    dono: '<span style="background:#f39c12;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">🔑 Dono</span>',
    gerente:
      '<span style="background:#2980b9;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">👔 Gerente</span>',
    funcionario:
      '<span style="background:#7f8c8d;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">👷 Funcionário</span>',
    garcom:
      '<span style="background:#27ae60;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">🍽️ Garçom</span>',
  };

  tbody.innerHTML = data
    .map((u) => {
      const isMe = u.id === _perfilId;
      const isAM = u.cargo === "adminMaster";
      const opcoesCargo = ["dono", "gerente", "funcionario", "garcom"]
        .map(
          (c) =>
            `<option value="${c}" ${u.cargo === c ? "selected" : ""}>${c}</option>`,
        )
        .join("");
      const acoes =
        isMe || isAM
          ? '<span style="color:#aaa;font-size:0.78rem">—</span>'
          : `
      <select onchange="amAlterarCargo('${u.id}', this.value)" style="padding:4px 8px;border-radius:6px;border:1px solid #ddd;font-size:0.8rem;margin-right:6px">
        ${opcoesCargo}
      </select>
      <button onclick="amExcluirUsuario('${u.id}','${u.email}')"
        style="background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem">
        <i class="fas fa-trash"></i>
      </button>`;
      return `<tr>
      <td><strong>${u.nome_display || "—"}</strong>${isMe ? ' <span style="font-size:0.7rem;color:#27ae60">(você)</span>' : ""}</td>
      <td style="font-size:0.85rem">${u.email}</td>
      <td>${cargoBadges[u.cargo] || u.cargo}</td>
      <td>${acoes}</td>
    </tr>`;
    })
    .join("");
}

async function amAlterarCargo(id, novoCargo) {
  if (perfilUsuario !== "adminMaster") return;
  if (!confirm(`Alterar cargo para "${novoCargo}"?`)) {
    amCarregarUsuarios();
    return;
  }
  const { error } = await supa
    .from("perfis_acesso")
    .update({ cargo: novoCargo })
    .eq("id", id);
  if (error) alert("❌ Erro: " + error.message);
  else {
    amCarregarUsuarios();
    carregarEquipe();
  }
}

async function amExcluirUsuario(id, email) {
  if (perfilUsuario !== "adminMaster") return;
  if (
    !confirm(
      `⚠️ Excluir o usuário "${email}"?\n\nIsso remove o perfil do banco. O acesso de autenticação pode precisar ser revogado no Supabase Dashboard.`,
    )
  )
    return;
  const { error } = await supa.from("perfis_acesso").delete().eq("id", id);
  if (error) alert("❌ Erro: " + error.message);
  else {
    alert("✅ Usuário excluído.");
    amCarregarUsuarios();
    carregarEquipe();
  }
}

async function cadastrarUsuario() {
  const email = document.getElementById("novo-user-email")?.value?.trim();
  const nomeDisplay =
    document.getElementById("novo-user-nome")?.value?.trim() || "";
  const senha = document.getElementById("novo-user-senha")?.value;
  const cargo = document.getElementById("novo-user-cargo")?.value;

  if (!email || !senha || senha.length < 6)
    return alert("Email e senha (mín. 6 caracteres) são obrigatórios");
  if (!nomeDisplay) return alert("O nome de exibição é obrigatório");

  // Apenas adminMaster pode criar dono
  if (cargo === "dono" && perfilUsuario !== "adminMaster")
    return alert("Apenas o Admin Master pode criar usuários com cargo Dono.");

  const btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Criando...";
  }

  try {
    // 1. Cria usuário na Autenticação do Supabase
    const { data, error } = await supa.auth.signUp({ email, password: senha });

    if (error) {
      alert("❌ Erro ao criar usuário: " + error.message);
      return;
    }

    if (data.user) {
      // 2. Salva perfil no banco usando upsert para evitar duplicata de chave
      const { error: errPerfil } = await supa
        .from("perfis_acesso")
        .upsert(
          [{ id: data.user.id, email, cargo, nome_display: nomeDisplay }],
          { onConflict: "id" },
        );

      if (errPerfil) {
        alert(
          "⚠️ Usuário de autenticação criado, mas erro ao salvar perfil: " +
            errPerfil.message,
        );
      } else {
        alert(
          "✅ Usuário cadastrado com sucesso!\n\nO usuário receberá um email de confirmação.",
        );
        document.getElementById("novo-user-email").value = "";
        document.getElementById("novo-user-nome").value = "";
        document.getElementById("novo-user-senha").value = "";
        carregarEquipe();
      }
    } else {
      alert("⚠️ Usuário criado. Aguardando confirmação de email para ativar.");
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-user-plus"></i> Criar';
    }
  }
}

function adicionarItem(etapaIndex) {
  const lista = document.getElementById(`itens-list-${etapaIndex}`);
  const itemDiv = document.createElement("div");
  itemDiv.className = "item-row";
  itemDiv.innerHTML = `
        <input type="text" class="input-modern" placeholder="Nome do item">
        <button type="button" class="btn-remove-item" 
                onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
  lista.appendChild(itemDiv);
}

function removerEtapa(index) {
  if (confirm("Remover esta etapa?")) {
    const container = document.getElementById("builder-steps");
    container.children[index].remove();
  }
}

// CARREGAR CUPONS
async function carregarCupons() {
  const { data } = await supa
    .from("cupons")
    .select("*")
    .order("created_at", { ascending: false });
  const tbody = document.getElementById("lista-cupons");

  if (!tbody) return;
  tbody.innerHTML = "";

  (data || []).forEach((c) => {
    const tipoLabel = c.tipo === "percentual" ? `${c.valor}%` : "Frete Grátis";
    const statusBadge = c.ativo
      ? '<span class="badge badge-success">Ativo</span>'
      : '<span class="badge badge-danger">Inativo</span>';

    // Uso / limite
    const usosRealizados = c.usos_realizados || c.usos_atual || 0;
    let usoHtml;
    if (c.limite_uso && c.limite_uso > 0) {
      const restante = c.limite_uso - usosRealizados;
      const esgotado = restante <= 0;
      usoHtml = `
        <div style="font-size:0.82rem">
          <span style="font-weight:700;color:${esgotado ? "#e74c3c" : "#27ae60"}">${usosRealizados}/${c.limite_uso}</span>
          ${esgotado ? '<span class="badge badge-danger" style="font-size:0.65rem">Esgotado</span>' : `<span style="color:#888;font-size:0.72rem">(${restante} restantes)</span>`}
        </div>`;
    } else {
      usoHtml = `<span style="color:#aaa;font-size:0.82rem">${usosRealizados} usos / ∞</span>`;
    }

    // Validade
    let validadeHtml = '<span style="color:#ccc;font-size:0.8rem">—</span>';
    if (c.validade) {
      const vDate = new Date(c.validade + "T00:00:00");
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const expirado = vDate < hoje;
      validadeHtml = `<span style="font-size:0.8rem;color:${expirado ? "#e74c3c" : "#555"}">${vDate.toLocaleDateString("pt-BR")}${expirado ? " <em style='font-size:0.7rem'>(Expirado)</em>" : ""}</span>`;
    }

    tbody.innerHTML += `
            <tr>
                <td><strong>${c.codigo}</strong></td>
                <td>${c.tipo === "percentual" ? "Percentual" : "Frete Grátis"}</td>
                <td>${tipoLabel}</td>
                <td>Gs ${c.minimo.toLocaleString("es-PY")}</td>
                <td>${usoHtml}</td>
                <td>${validadeHtml}</td>
                <td>${statusBadge}</td>
                <td class="actions-cell">
                    <button class="btn btn-sm btn-primary" onclick='editarCupom(${JSON.stringify(c)})'>
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deletarCupom(${c.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
  });
}

// ABRIR MODAL CUPOM
function abrirModalCupom(cupom = null) {
  document.getElementById("cupom-id").value = cupom ? cupom.id : "";
  document.getElementById("cupom-codigo").value = cupom ? cupom.codigo : "";
  document.getElementById("cupom-tipo").value = cupom
    ? cupom.tipo
    : "percentual";
  document.getElementById("cupom-valor").value = cupom ? cupom.valor : "";
  document.getElementById("cupom-minimo").value = cupom ? cupom.minimo : "";
  document.getElementById("cupom-ativo").checked = cupom ? cupom.ativo : true;
  // Limite de usos e validade
  document.getElementById("cupom-limite").value = cupom?.limite_uso ?? "";
  document.getElementById("cupom-validade").value = cupom?.validade
    ? cupom.validade.split("T")[0]
    : "";

  alterarTipoCupom();

  const modal = document.getElementById("modal-cupom");
  modal.style.display = "flex";
  modal.classList.add("active");
}

function editarCupom(cupom) {
  abrirModalCupom(cupom);
}

function alterarTipoCupom() {
  const tipo = document.getElementById("cupom-tipo").value;
  const boxValor = document.getElementById("box-valor-cupom");
  boxValor.style.display = tipo === "percentual" ? "block" : "none";
}

// SALVAR CUPOM
async function salvarCupom() {
  const id = document.getElementById("cupom-id").value;
  const limiteRaw = parseInt(document.getElementById("cupom-limite").value);
  const validadeRaw = document.getElementById("cupom-validade").value;

  const dados = {
    codigo: document.getElementById("cupom-codigo").value.toUpperCase(),
    tipo: document.getElementById("cupom-tipo").value,
    valor: parseFloat(document.getElementById("cupom-valor").value) || 0,
    minimo: parseFloat(document.getElementById("cupom-minimo").value) || 0,
    ativo: document.getElementById("cupom-ativo").checked,
    limite_uso: !isNaN(limiteRaw) && limiteRaw > 0 ? limiteRaw : null,
    validade: validadeRaw || null,
  };

  if (!dados.codigo) {
    alert("Digite um código para o cupom");
    return;
  }

  let error;
  if (id) {
    ({ error } = await supa.from("cupons").update(dados).eq("id", id));
  } else {
    ({ error } = await supa.from("cupons").insert([dados]));
  }

  if (error) {
    alert("Erro: " + error.message);
  } else {
    alert("✅ Cupom salvo com sucesso!");
    document.getElementById("modal-cupom").classList.remove("active"); // Fecha o modal
    document.getElementById("modal-cupom").style.display = "none";
    carregarCupons();
  }
}

// DELETAR CUPOM
async function deletarCupom(id) {
  if (confirm("Deletar este cupom?")) {
    const { error } = await supa.from("cupons").delete().eq("id", id);
    if (error) alert("Erro: " + error.message);
    else carregarCupons();
  }
}

// ── Avisar cliente via WhatsApp que o pedido está pronto ──────────
async function avisarClientePronto(pedidoId) {
  const { data: p } = await supa
    .from("pedidos")
    .select("cliente_nome, cliente_telefone, uid_temporal")
    .eq("id", pedidoId)
    .single();
  if (!p) {
    alert("Pedido não encontrado.");
    return;
  }

  const tel = (p.cliente_telefone || "").replace(/\D/g, "");
  if (!tel) {
    alert("Este pedido não tem número de telefone registrado.");
    return;
  }

  // Carrega nome da loja
  const nomeRestaurante = NOME_RESTAURANTE || "Restaurante";
  const nomeCliente = p.cliente_nome || "Cliente";
  const numPedido = p.uid_temporal || pedidoId;

  // Mensagem em 3 idiomas
  const msgs = {
    pt: `Olá, ${nomeCliente}! 🎉\nSeu pedido #${numPedido} está pronto! 🍽️\n\nObrigado por escolher ${nomeRestaurante}!`,
    es: `¡Hola, ${nomeCliente}! 🎉\n¡Tu pedido #${numPedido} está listo! 🍽️\n\n¡Gracias por elegir ${nomeRestaurante}!`,
    gn: `Mba'éichapa, ${nomeCliente}! 🎉\nNde pedido #${numPedido} oĩma! 🍽️\n\nAguyje ${nomeRestaurante}-pe remomba'apo haguépe!`,
  };

  // Modal de seleção de idioma
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:20px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h4 style="margin:0;color:#25D366"><i class="fab fa-whatsapp"></i> Avisar Cliente</h4>
        <button onclick="this.closest('[style]').remove()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>
      </div>
      <p style="font-size:0.85rem;color:#555;margin-bottom:14px">Pedido <strong>#${numPedido}</strong> — <strong>${nomeCliente}</strong></p>
      <p style="font-size:0.8rem;font-weight:600;color:#333;margin-bottom:10px">Escolha o idioma da mensagem:</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${Object.entries({
          pt: "🇧🇷 Português",
          es: "🇵🇾 Español",
          gn: "🌿 Guarani",
        })
          .map(
            ([k, lbl]) => `
          <button onclick="window.open('https://wa.me/595${tel.replace(/^0/, "")}?text='+encodeURIComponent('${msgs[k].replace(/'/g, "\\'").replace(/\n/g, "%0A")}'),'_blank');this.closest('[style]').remove()"
            style="background:#f0fff4;border:2px solid #25D366;border-radius:10px;padding:11px 14px;cursor:pointer;text-align:left;font-size:0.88rem;font-weight:600;color:#155c24;transition:all .15s"
            onmouseover="this.style.background='#25D366';this.style.color='#fff'"
            onmouseout="this.style.background='#f0fff4';this.style.color='#155c24'">
            ${lbl}
          </button>`,
          )
          .join("")}
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function confirmarEntregaFuncionario(pedidoId) {
  if (!confirm("Confirmar que este pedido foi entregue ao cliente?")) {
    return;
  }

  try {
    const { error } = await supa
      .from("pedidos")
      .update({
        status: "entregue",
        entrega_confirmada_em: new Date().toISOString(),
        confirmacao_tipo: "funcionario",
      })
      .eq("id", pedidoId);

    if (error) throw error;

    alert("✅ Entrega confirmada com sucesso!");
    carregarPedidos();
  } catch (err) {
    console.error("Erro ao confirmar entrega:", err);
    alert("Erro ao confirmar entrega");
  }
}

async function fecharTodasMesas() {
  const { data, error } = await supa
    .from("pedidos")
    .select("id, cliente_nome, tipo_entrega, status")
    .in("status", ["pendente", "em_preparo", "pronto_entrega", "saiu_entrega"])
    .in("tipo_entrega", ["balcao", "retirada", "local"]);
  if (error || !data || data.length === 0) {
    alert("Nenhum pedido de Mesa/Retirada/Local em aberto.");
    return;
  }
  const lista = data
    .map((p) => `#${p.id} — ${p.cliente_nome || "Mesa"} (${p.tipo_entrega})`)
    .join("\n");
  if (
    !confirm(`Baixar ${data.length} pedido(s) Mesa/Retirada/Local?\n\n${lista}`)
  )
    return;
  const now = new Date().toISOString();
  const { error: err } = await supa
    .from("pedidos")
    .update({ status: "entregue", tempo_entregue: now })
    .in(
      "id",
      data.map((p) => p.id),
    );
  if (err) {
    alert("Erro: " + err.message);
    return;
  }
  alert(`✅ ${data.length} pedido(s) baixado(s)!`);
  carregarPedidos();
  carregarMonitorMesas();
  if (typeof calcularFinanceiro === "function") calcularFinanceiro();
}

async function baixarTodosNaoDelivery() {
  const { data, error } = await supa
    .from("pedidos")
    .select("id, cliente_nome, status")
    .in("status", ["saiu_entrega", "pronto_entrega"])
    .eq("tipo_entrega", "delivery");
  if (error || !data || data.length === 0) {
    alert("Nenhum delivery para confirmar entrega.");
    return;
  }
  const lista = data
    .map((p) => `#${p.id} — ${p.cliente_nome || "Cliente"}`)
    .join("\n");
  if (!confirm(`Confirmar entrega de ${data.length} delivery(s)?\n\n${lista}`))
    return;
  const now = new Date().toISOString();
  const { error: err } = await supa
    .from("pedidos")
    .update({
      status: "entregue",
      tempo_entregue: now,
      entrega_confirmada_em: now,
      confirmacao_tipo: "massa",
    })
    .in(
      "id",
      data.map((p) => p.id),
    );
  if (err) {
    alert("Erro: " + err.message);
    return;
  }
  alert(`✅ ${data.length} delivery(s) confirmado(s)!`);
  carregarPedidos();
  if (typeof calcularFinanceiro === "function") calcularFinanceiro();
}

let graficoInstance = null;

// ===== ABRIR MODAL DE GRÁFICOS =====
function abrirGraficos() {
  const modal = document.getElementById("modal-graficos");
  if (!modal) {
    console.error("Modal de gráficos não encontrado");
    return;
  }
  modal.style.display = "flex";

  // Carrega dados padrão de 7 dias
  carregarDadosGrafico("7");
}

// ===== CARREGAR DADOS DO GRÁFICO =====
async function carregarDadosGrafico(dias) {
  try {
    // Atualiza botões visuais
    document.querySelectorAll(".btn-periodo").forEach((btn) => {
      const btnDias = btn.getAttribute("data-dias");
      if (btnDias === dias) {
        btn.style.background = "#8e44ad";
        btn.style.color = "#fff";
      } else {
        btn.style.background = "#bdc3c7";
        btn.style.color = "#333";
      }
    });

    // Calcula data de início
    const dataFim = new Date();
    const dataInicio = new Date();
    dataInicio.setDate(dataInicio.getDate() - parseInt(dias));

    // Busca pedidos no período
    const { data: pedidos, error } = await supa
      .from("pedidos")
      .select("*")
      .gte("created_at", dataInicio.toISOString())
      .lte("created_at", dataFim.toISOString())
      .neq("status", "cancelado");

    if (error) throw error;

    // Processa dados
    processarDadosGrafico(pedidos, dias);
  } catch (err) {
    console.error("Erro ao carregar dados do gráfico:", err);
    alert("Erro ao carregar gráfico");
  }
}

// ===== PROCESSAR E EXIBIR DADOS =====
function processarDadosGrafico(pedidos, dias) {
  // Agrupa vendas por dia
  const vendasPorDia = {};
  let totalPeriodo = 0;

  pedidos.forEach((p) => {
    const data = new Date(p.created_at).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
    const valor = p.total_geral || 0;
    vendasPorDia[data] = (vendasPorDia[data] || 0) + valor;
    totalPeriodo += valor;
  });

  // Ordena por data
  const datasOrdenadas = Object.keys(vendasPorDia).sort((a, b) => {
    const [diaA, mesA] = a.split("/");
    const [diaB, mesB] = b.split("/");
    return new Date(2024, mesA - 1, diaA) - new Date(2024, mesB - 1, diaB);
  });

  const valores = datasOrdenadas.map((d) => vendasPorDia[d]);

  // Calcula estatísticas
  const mediaPorDia = totalPeriodo / parseInt(dias);
  const melhorValor = Math.max(...valores);
  const piorValor = Math.min(...valores);
  const melhorDia = datasOrdenadas[valores.indexOf(melhorValor)];
  const piorDia = datasOrdenadas[valores.indexOf(piorValor)];

  // Atualiza cards
  document.getElementById("graf-total-periodo").textContent =
    `Gs ${totalPeriodo.toLocaleString("es-PY")}`;
  document.getElementById("graf-media-dia").textContent =
    `Gs ${Math.round(mediaPorDia).toLocaleString("es-PY")}`;
  document.getElementById("graf-melhor-dia").textContent =
    `${melhorDia} - Gs ${melhorValor.toLocaleString("es-PY")}`;
  document.getElementById("graf-pior-dia").textContent =
    `${piorDia} - Gs ${piorValor.toLocaleString("es-PY")}`;

  // Gera cores das barras
  const cores = valores.map((v) => {
    if (v === melhorValor) return "#27ae60"; // Verde para melhor
    if (v === piorValor) return "#e74c3c"; // Vermelho para pior
    return "#3498db"; // Azul para demais
  });

  // Renderiza gráfico
  renderizarGrafico(datasOrdenadas, valores, cores);
}

// ══════════════════════════════════════════════════════════════════════
//  ESTATÍSTICAS DE VENDAS
// ══════════════════════════════════════════════════════════════════════

let _estChart = null;
let _estDados = [];
let _estCategorias = [];

function initEstatisticas() {
  // Define datas padrão: últimos 30 dias
  const hoje = new Date();
  const ini = new Date(hoje);
  ini.setDate(ini.getDate() - 30);
  const fmt = (d) => d.toISOString().split("T")[0];
  const iniEl = document.getElementById("est-ini");
  const fimEl = document.getElementById("est-fim");
  if (iniEl && !iniEl.value) iniEl.value = fmt(ini);
  if (fimEl && !fimEl.value) fimEl.value = fmt(hoje);
  gerarEstatisticas();
}

async function _estPopularCategorias() {
  const sel = document.getElementById("est-filtro-cat");
  if (!sel || sel.options.length > 1) return;
  try {
    const { data } = await supa
      .from("categorias")
      .select("slug, nome")
      .order("nome");
    (data || []).forEach((c) => {
      const o = document.createElement("option");
      o.value = c.slug;
      o.textContent = c.nome;
      sel.appendChild(o);
    });
  } catch (_) {}
}

async function gerarEstatisticas() {
  const loading = document.getElementById("est-loading");
  if (loading) loading.style.display = "flex";

  const ini = document.getElementById("est-ini")?.value;
  const fim = document.getElementById("est-fim")?.value;

  try {
    let query = supa
      .from("pedidos")
      .select("itens, total_geral, subtotal, created_at")
      .eq("status", "entregue");
    if (ini) query = query.gte("created_at", ini + "T00:00:00");
    if (fim) query = query.lte("created_at", fim + "T23:59:59");
    const { data, error } = await query;
    if (error) throw error;

    // Agrega por produto
    // Agrega por produto + variação
const mapa = {};
let faturamentoTotal = 0;
let totalPedidos = (data || []).length;

(data || []).forEach((ped) => {
  faturamentoTotal += ped.total_geral || ped.subtotal || 0;
  (Array.isArray(ped.itens) ? ped.itens : []).forEach((item) => {
    const nomeBase = item.nome || item.n || "Produto";
    const variacao = item.variacao || item.t || "";
    // Chave composta: nomeBase + (variacao ? " (" + variacao + ")" : "")
    const chave = variacao ? `${nomeBase} (${variacao})` : nomeBase;
    const preco = item.preco || item.p || 0;
    const qtd = item.qtd || item.q || 1;
    const cat = item.categoria_slug || item.cat || "";
    const unid = item.unidade_venda || item.unid || "un";
    if (!mapa[chave]) {
      mapa[chave] = {
        nome: chave,          // nome exibido (com variação)
        nomeBase,             // guardamos para referência
        variacao,
        preco,
        cat,
        unid,
        qtd: 0,
        fat: 0,
      };
    }
    mapa[chave].qtd += qtd;
    mapa[chave].fat += preco * qtd;
  });
});

_estDados = Object.values(mapa).sort((a, b) => b.fat - a.fat);

    // KPIs
    const ticket =
      totalPedidos > 0 ? Math.round(faturamentoTotal / totalPedidos) : 0;
    const lucroEst = Math.round(faturamentoTotal * 0.3); // estimado 30%
    const setKpi = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setKpi(
      "est-kpi-faturamento",
      "Gs " + faturamentoTotal.toLocaleString("es-PY"),
    );
    setKpi("est-kpi-ticket", "Gs " + ticket.toLocaleString("es-PY"));
    setKpi("est-kpi-lucro", "Gs " + lucroEst.toLocaleString("es-PY"));
    setKpi("est-kpi-pedidos", totalPedidos.toLocaleString("es-PY"));

    estAplicarFiltros();
  } catch (e) {
    alert("Erro ao carregar estatísticas: " + e.message);
  } finally {
    if (loading) loading.style.display = "none";
  }
}

function estAplicarFiltros() {
  const cat = document.getElementById("est-filtro-cat")?.value || "";
  const unid = document.getElementById("est-filtro-unidade")?.value || "";
  let lista = _estDados.slice();
  if (cat) lista = lista.filter((p) => p.cat === cat);
  if (unid) lista = lista.filter((p) => p.unid === unid);

  // Gráfico top 15
  const top15 = lista.slice(0, 15);
  _estDesenharGrafico(top15);

  // Tabela completa
  const tbody = document.getElementById("est-tabela-body");
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:20px">Nenhum dado no período</td></tr>';
    return;
  }
  tbody.innerHTML = lista
    .map((p) => {
      const markup =
        p.preco > 0
          ? Math.round((p.fat / (p.preco * p.qtd * 0.6) - 1) * 100)
          : 0;
      return `<tr>
      <td style="font-weight:600">${p.nome}</td>
      <td style="color:#888;font-size:0.82rem">${p.cat || "—"}</td>
      <td style="text-align:center">${p.unid === "kg" ? p.qtd.toFixed(3) + " kg" : p.qtd + " un"}</td>
      <td style="text-align:center;color:${markup > 0 ? "#16a34a" : "#888"}">${markup > 0 ? markup + "%" : "—"}</td>
      <td style="text-align:right;font-weight:700;color:#1a7a2e">Gs ${p.fat.toLocaleString("es-PY")}</td>
    </tr>`;
    })
    .join("");
}

function _estDesenharGrafico(dados) {
  const canvas = document.getElementById("est-grafico");
  if (!canvas) return;
  if (_estChart) {
    _estChart.destroy();
    _estChart = null;
  }
  if (!dados.length) return;
  const ctx = canvas.getContext("2d");
  _estChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: dados.map((p) =>
        p.nome.length > 20 ? p.nome.slice(0, 18) + "…" : p.nome,
      ),
      datasets: [
        {
          label: "Faturamento (Gs)",
          data: dados.map((p) => p.fat),
          backgroundColor: "rgba(26,122,46,0.75)",
          borderRadius: 6,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => "Gs " + ctx.parsed.y.toLocaleString("es-PY"),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "Gs " + (v / 1000).toFixed(0) + "k" },
        },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════════
//  FICHA TÉCNICA — init stub (lógica real já existe via ftMostrarPanel)
// ══════════════════════════════════════════════════════════════════════

function initFichaTecnica() {
  ftMostrarPanel("insumos");
}

// ══════════════════════════════════════════════════════════════════════
//  CRM — Clientes & Cashback
// ══════════════════════════════════════════════════════════════════════

let _crmClientes = [];
let _crmAbaAtual = "todos";
let _crmCashbackPct = 2;
let _crmCashbackVal = 30;

async function initCRM() {
  await _crmCarregarConfig();
  await _crmCarregarClientes();
}

async function _crmCarregarConfig() {
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("cashback_pct, cashback_validade_dias")
      .maybeSingle();
    if (data) {
      _crmCashbackPct = data.cashback_pct ?? 2;
      _crmCashbackVal = data.cashback_validade_dias ?? 30;
      const pctEl = document.getElementById("crm-cfg-pct");
      const valEl = document.getElementById("crm-cfg-val");
      if (pctEl) pctEl.value = _crmCashbackPct;
      if (valEl) valEl.value = _crmCashbackVal;
    }
  } catch (_) {}
}

async function crmSalvarConfig() {
  const pct = parseFloat(document.getElementById("crm-cfg-pct")?.value) || 0;
  const val = parseInt(document.getElementById("crm-cfg-val")?.value) || 30;
  try {
    await supa
      .from("configuracoes")
      .update({ cashback_pct: pct, cashback_validade_dias: val })
      .gt("id", 0);
    _crmCashbackPct = pct;
    _crmCashbackVal = val;
    alert("✅ Configurações de cashback salvas!");
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function _crmCarregarClientes() {
  try {
    const { data, error } = await supa
      .from("clientes")
      .select(
        "id, nome, telefone, nascimento, cashback_saldo, total_gasto, created_at",
      )
      .order("nome");
    if (error) throw error;
    _crmClientes = data || [];
    _crmAtualizarKPIs();
    _crmRenderizarAniversariantes();
    crmMudarAba(_crmAbaAtual);
  } catch (e) {
    const tbody = document.getElementById("crm-lista-clientes");
    if (tbody)
      tbody.innerHTML = `<tr><td colspan="6" style="color:#e74c3c;padding:20px;text-align:center">Erro: ${e.message}</td></tr>`;
  }
}

function _crmAtualizarKPIs() {
  const total = _crmClientes.length;
  const comSaldo = _crmClientes.filter(
    (c) => (c.cashback_saldo || 0) > 0,
  ).length;
  const cashTot = _crmClientes.reduce((s, c) => s + (c.cashback_saldo || 0), 0);
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("crm-kpi-total", total);
  set("crm-kpi-comSaldo", comSaldo);
  set("crm-kpi-cashback", "Gs " + cashTot.toLocaleString("es-PY"));
}

function _crmRenderizarAniversariantes() {
  const el = document.getElementById("crm-widget-aniversariantes");
  if (!el) return;
  const hoje = new Date();
  const mm = hoje.getMonth() + 1;
  const dd = hoje.getDate();
  const aniv = _crmClientes.filter((c) => {
    if (!c.nascimento) return false;
    const [, m, d] = c.nascimento.split("-");
    return parseInt(m) === mm && parseInt(d) === dd;
  });
  el.innerHTML = aniv.length
    ? aniv
        .map(
          (c) =>
            `<div>🎂 <b>${c.nome}</b> <span style="color:#888">${c.telefone || ""}</span></div>`,
        )
        .join("")
    : '<span style="color:#aaa;font-size:0.8rem">Nenhum aniversariante hoje</span>';
}

function crmMudarAba(aba) {
  _crmAbaAtual = aba;
  document
    .querySelectorAll(".crm-aba-btn")
    .forEach((b) => b.classList.remove("active"));
  const btn = document.getElementById(`crm-aba-${aba}`);
  if (btn) btn.classList.add("active");
  crmFiltrarClientes(
    document.querySelector("#crm input[type=text]")?.value || "",
  );
}

function crmFiltrarClientes(busca) {
  busca = (busca || "").toLowerCase();
  const hoje = new Date();
  const mm = hoje.getMonth() + 1;
  let lista = _crmClientes.slice();
  if (_crmAbaAtual === "aniversariantes") {
    lista = lista.filter((c) => {
      if (!c.nascimento) return false;
      const [, m] = c.nascimento.split("-");
      return parseInt(m) === mm;
    });
  }
  if (busca) {
    lista = lista.filter(
      (c) =>
        (c.nome || "").toLowerCase().includes(busca) ||
        (c.telefone || "").includes(busca),
    );
  }
  _crmRenderizarTabela(lista);
}

function _crmRenderizarTabela(lista) {
  const tbody = document.getElementById("crm-lista-clientes");
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:24px">Nenhum cliente encontrado</td></tr>';
    return;
  }
  tbody.innerHTML = lista
    .map((c) => {
      const saldo = (c.cashback_saldo || 0).toLocaleString("es-PY");
      const gasto = (c.total_gasto || 0).toLocaleString("es-PY");
      const nasc = c.nascimento
        ? new Date(c.nascimento + "T12:00:00").toLocaleDateString("pt-BR")
        : "—";
      return `<tr>
      <td style="font-weight:600">${c.nome || "—"}</td>
      <td>${c.telefone || "—"}</td>
      <td>${nasc}</td>
      <td style="color:${c.cashback_saldo > 0 ? "#27ae60" : "#aaa"};font-weight:700">Gs ${saldo}</td>
      <td>Gs ${gasto}</td>
      <td style="text-align:center">
        <button onclick="crmAbrirModalCliente(${c.id})"
          style="padding:5px 10px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:700;margin-right:4px">
          ✏️ Editar
        </button>
        <button onclick="crmAbrirHistorico(${c.id})"
          style="padding:5px 10px;background:#e3f2fd;color:#1565c0;border:1px solid #90caf9;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:700">
          📋 Histórico
        </button>
      </td>
    </tr>`;
    })
    .join("");
}

function crmAbrirModalCliente(id = null) {
  const cli = id ? _crmClientes.find((c) => c.id === id) : null;
  document.getElementById("crm-cli-id").value = cli?.id || "";
  document.getElementById("crm-cli-nome").value = cli?.nome || "";
  document.getElementById("crm-cli-tel").value = cli?.telefone || "";
  document.getElementById("crm-cli-nasc").value = cli?.nascimento || "";
  document.getElementById("crm-cli-saldo").value = cli?.cashback_saldo || 0;
  const modal = document.getElementById("modal-crm-cliente");
  if (modal) modal.style.display = "flex";
}

async function crmSalvarCliente() {
  const id = document.getElementById("crm-cli-id").value;
  const dados = {
    nome: document.getElementById("crm-cli-nome").value.trim(),
    telefone: document.getElementById("crm-cli-tel").value.trim(),
    nascimento: document.getElementById("crm-cli-nasc").value || null,
    cashback_saldo:
      parseFloat(document.getElementById("crm-cli-saldo").value) || 0,
  };
  if (!dados.nome) {
    alert("⚠️ Nome é obrigatório.");
    return;
  }
  try {
    if (id) {
      await supa.from("clientes").update(dados).eq("id", id);
    } else {
      await supa.from("clientes").insert([dados]);
    }
    fecharModal("modal-crm-cliente");
    await _crmCarregarClientes();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function crmAbrirHistorico(clienteId) {
  const modal = document.getElementById("modal-crm-hist");
  if (!modal) return;
  const tbody = document.getElementById("crm-hist-body");
  if (tbody)
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px">Carregando...</td></tr>';
  modal.style.display = "flex";
  try {
    const { data } = await supa
      .from("pedidos")
      .select("id, created_at, total_geral, forma_pagamento, status")
      .eq("cliente_id", clienteId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (tbody) {
      tbody.innerHTML = (data || []).length
        ? (data || [])
            .map(
              (p) => `<tr>
            <td>${new Date(p.created_at).toLocaleDateString("pt-BR")}</td>
            <td>${p.forma_pagamento || "—"}</td>
            <td>${p.status || "—"}</td>
            <td style="font-weight:700">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</td>
          </tr>`,
            )
            .join("")
        : '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px">Nenhum pedido encontrado</td></tr>';
    }
  } catch (e) {
    if (tbody)
      tbody.innerHTML = `<tr><td colspan="4" style="color:#e74c3c;padding:20px">Erro: ${e.message}</td></tr>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  FILIAIS / SUCURSALES
// ══════════════════════════════════════════════════════════════════════

let _filiais = [];

async function initFiliais() {
  await _filiaisCarregar();
  await _filiaisCarregarUsuarios();
}

async function _filiaisCarregar() {
  try {
    const { data } = await supa.from("filiais").select("*").order("nome");
    _filiais = data || [];
    _filiaisRenderizar(_filiais);
  } catch (e) {
    const el = document.getElementById("filiais-lista");
    if (el)
      el.innerHTML = `<div style="color:#e74c3c;padding:20px">Erro: ${e.message}</div>`;
  }
}

function _filiaisRenderizar(lista) {
  const el = document.getElementById("filiais-lista");
  if (!el) return;
  if (!lista.length) {
    el.innerHTML =
      '<div style="text-align:center;color:#aaa;padding:32px">Nenhuma sucursal cadastrada</div>';
    return;
  }
  const statusLabel = {
    ativa: "✅ Activa",
    inativa: "⛔ Inactiva",
    manutencao: "🔧 Mantenimiento",
  };
  el.innerHTML = lista
    .map(
      (f) => `
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-weight:700;font-size:1rem">${f.nome}</div>
        <div style="color:#6b7280;font-size:0.83rem">${f.endereco || ""}</div>
        <div style="font-size:0.8rem;margin-top:4px">${statusLabel[f.status] || f.status}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="abrirModalFilial(${f.id})"
          style="padding:7px 14px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.8rem">
          ✏️ Editar
        </button>
        <button onclick="excluirFilial(${f.id})"
          style="padding:7px 14px;background:#fef2f2;color:#e74c3c;border:1px solid #fca5a5;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.8rem">
          🗑️
        </button>
      </div>
    </div>`,
    )
    .join("");
}

async function _filiaisCarregarUsuarios() {
  try {
    const { data } = await supa
      .from("perfis")
      .select("id, nome, email, perfil, ativo, filial_id")
      .order("nome");
    const tbody = document.getElementById("filiais-usuarios-body");
    if (!tbody) return;
    if (!(data || []).length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:20px">Sin usuarios</td></tr>';
      return;
    }
    tbody.innerHTML = (data || [])
      .map((u) => {
        const filNome = _filiais.find((f) => f.id === u.filial_id)?.nome || "—";
        return `<tr>
        <td style="padding:12px 16px;font-weight:600">${u.nome || u.email || "—"}</td>
        <td style="padding:12px 16px;font-size:0.82rem;color:#6b7280">${u.perfil || "—"}</td>
        <td style="padding:12px 16px;font-size:0.82rem">${filNome}</td>
        <td style="padding:12px 16px;text-align:center">${u.ativo ? "✅" : "⛔"}</td>
        <td style="padding:12px 16px;text-align:center">
          <button onclick="abrirModalUsuarioAdmin('${u.id}')"
            style="padding:5px 12px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:700">
            Editar
          </button>
        </td>
      </tr>`;
      })
      .join("");
  } catch (e) {}
}

function abrirModalFilial(id = null) {
  const f = id ? _filiais.find((x) => x.id === id) : null;
  const titulo = document.getElementById("filial-modal-titulo");
  if (titulo) titulo.textContent = f ? "Editar Sucursal" : "Nueva Sucursal";
  document.getElementById("filial-id").value = f?.id || "";
  document.getElementById("filial-nome").value = f?.nome || "";
  document.getElementById("filial-endereco").value = f?.endereco || "";
  document.getElementById("filial-lat").value = f?.lat || "";
  document.getElementById("filial-lng").value = f?.lng || "";
  document.getElementById("filial-whatsapp").value = f?.whatsapp || "";
  document.getElementById("filial-raio").value = f?.raio_km || 10;
  document.getElementById("filial-taxa").value = f?.taxa_frete || 0;
  document.getElementById("filial-status").value = f?.status || "ativa";
  const modal = document.getElementById("modal-filial");
  if (modal) modal.style.display = "flex";
}

async function salvarFilial() {
  const id = document.getElementById("filial-id").value;
  const dados = {
    nome: document.getElementById("filial-nome").value.trim(),
    endereco: document.getElementById("filial-endereco").value.trim(),
    lat: parseFloat(document.getElementById("filial-lat").value) || null,
    lng: parseFloat(document.getElementById("filial-lng").value) || null,
    whatsapp: document.getElementById("filial-whatsapp").value.trim(),
    raio_km: parseFloat(document.getElementById("filial-raio").value) || 10,
    taxa_frete: parseFloat(document.getElementById("filial-taxa").value) || 0,
    status: document.getElementById("filial-status").value,
  };
  if (!dados.nome) {
    alert("⚠️ Nome é obrigatório.");
    return;
  }
  try {
    if (id) {
      await supa.from("filiais").update(dados).eq("id", id);
    } else {
      await supa.from("filiais").insert([dados]);
    }
    fecharModal("modal-filial");
    await _filiaisCarregar();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function excluirFilial(id) {
  if (!confirm("Excluir esta sucursal?")) return;
  try {
    await supa.from("filiais").delete().eq("id", id);
    await _filiaisCarregar();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

function abrirModalUsuarioAdmin(perfilId) {
  const modal = document.getElementById("modal-filial-usuario");
  if (!modal) return;
  document.getElementById("ua-perfil-id").value = perfilId;
  // Popula select de filiais
  const selFil = document.getElementById("ua-filial");
  if (selFil) {
    selFil.innerHTML =
      '<option value="">— Sem filial —</option>' +
      _filiais
        .map((f) => `<option value="${f.id}">${f.nome}</option>`)
        .join("");
  }
  modal.style.display = "flex";
}

function onRoleChange() {
  const role = document.getElementById("ua-role")?.value;
  const row = document.getElementById("ua-filial-row");
  if (row)
    row.style.display =
      role === "adminMaster" || role === "gerente" ? "none" : "";
}

async function salvarUsuarioAdmin() {
  const id = document.getElementById("ua-perfil-id").value;
  const dados = {
    nome: document.getElementById("ua-nome")?.value.trim(),
    perfil: document.getElementById("ua-role")?.value,
    filial_id: document.getElementById("ua-filial")?.value || null,
    ativo: document.getElementById("ua-ativo")?.checked ?? true,
  };
  try {
    await supa.from("perfis").update(dados).eq("id", id);
    fecharModal("modal-filial-usuario");
    await _filiaisCarregarUsuarios();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  MENSALISTAS / PLANOS
// ══════════════════════════════════════════════════════════════════════

let _mensPlanos = [];
let _mensFiltrado = [];

async function initMensalistas() {
  await _mensCarregarPlanos();
  await _mensPopularSelects();
}

async function _mensCarregarPlanos() {
  const loading = document.getElementById("mens-loading");
  if (loading) loading.style.display = "flex";
  try {
    const { data, error } = await supa
      .from("planos_mensalistas")
      .select("*, clientes(nome, telefone)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    _mensPlanos = data || [];
    _mensAtualizarKPIs();
    mensFiltrar();
  } catch (e) {
    const el = document.getElementById("mens-lista-planos");
    if (el)
      el.innerHTML = `<div style="color:#e74c3c;padding:20px">Erro: ${e.message}<br><small>Verifique se a tabela "planos_mensalistas" existe no Supabase.</small></div>`;
  } finally {
    if (loading) loading.style.display = "none";
  }
}

function _mensAtualizarKPIs() {
  const total = _mensPlanos.length;
  const ativos = _mensPlanos.filter((p) => p.ativo).length;
  const receita = _mensPlanos
    .filter((p) => p.ativo)
    .reduce((s, p) => s + (p.valor || 0), 0);
  const itens = _mensPlanos
    .filter((p) => p.ativo)
    .reduce((s, p) => s + ((p.qtd_total || 0) - (p.qtd_usada || 0)), 0);
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("mens-kpi-total", total);
  set("mens-kpi-ativos", ativos);
  set("mens-kpi-receita", "Gs " + receita.toLocaleString("es-PY"));
  set("mens-kpi-itens", itens);
}

function mensFiltrar() {
  const busca = (
    document.getElementById("mens-busca")?.value || ""
  ).toLowerCase();
  const status =
    document.getElementById("mens-filtro-status")?.value || "todos";
  _mensFiltrado = _mensPlanos.filter((p) => {
    const nome = (p.clientes?.nome || "").toLowerCase();
    const tel = p.clientes?.telefone || "";
    const produto = (p.produto || "").toLowerCase();
    const matchB =
      !busca ||
      nome.includes(busca) ||
      tel.includes(busca) ||
      produto.includes(busca);
    const matchS =
      status === "todos" ||
      (status === "ativo" && p.ativo) ||
      (status === "inativo" && !p.ativo);
    return matchB && matchS;
  });
  _mensRenderizar(_mensFiltrado);
}

function _mensRenderizar(lista) {
  const el = document.getElementById("mens-lista-planos");
  if (!el) return;
  if (!lista.length) {
    el.innerHTML =
      '<div style="text-align:center;color:#aaa;padding:32px">Nenhum plano encontrado</div>';
    return;
  }
  el.innerHTML = lista
    .map((p) => {
      const restante = (p.qtd_total || 0) - (p.qtd_usada || 0);
      const pct =
        p.qtd_total > 0
          ? Math.round(((p.qtd_usada || 0) / p.qtd_total) * 100)
          : 0;
      const barColor =
        pct >= 90 ? "#e74c3c" : pct >= 60 ? "#f39c12" : "#1a7a2e";
      const fim = p.data_fim
        ? new Date(p.data_fim + "T12:00:00").toLocaleDateString("pt-BR")
        : "—";
      return `<div style="background:#fff;border:1.5px solid ${p.ativo ? "#e5e7eb" : "#fca5a5"};border-radius:14px;padding:18px 20px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-weight:800;font-size:1rem">${p.clientes?.nome || "—"}</div>
          <div style="color:#6b7280;font-size:0.82rem">${p.clientes?.telefone || ""} • ${p.produto || "—"}</div>
          <div style="font-size:0.8rem;margin-top:4px;color:#555">Vence: ${fim} • Gs ${(p.valor || 0).toLocaleString("es-PY")}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="mensAbrirEntrega(${p.id})"
            style="padding:6px 12px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem">
            📦 Entregar
          </button>
          <button onclick="mensAbrirHistorico(${p.id})"
            style="padding:6px 12px;background:#e3f2fd;color:#1565c0;border:1px solid #90caf9;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem">
            📋 Histórico
          </button>
          <button onclick="mensAbrirModalPlano(${p.id})"
            style="padding:6px 12px;background:#f9fafb;color:#4b5563;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem">
            ✏️
          </button>
        </div>
      </div>
      <div style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:4px">
          <span>${p.qtd_usada || 0} / ${p.qtd_total || 0} itens usados</span>
          <span style="color:${barColor};font-weight:700">${restante} restantes</span>
        </div>
        <div style="background:#f3f4f6;border-radius:4px;height:8px">
          <div style="background:${barColor};width:${pct}%;height:8px;border-radius:4px;transition:width 0.3s"></div>
        </div>
      </div>
    </div>`;
    })
    .join("");
}

async function _mensPopularSelects() {
  // Clientes
  try {
    const { data: clis } = await supa
      .from("clientes")
      .select("id, nome")
      .order("nome");
    const selCli = document.getElementById("mens-plano-cli-sel");
    if (selCli) {
      selCli.innerHTML =
        '<option value="">— Selecione o cliente —</option>' +
        (clis || [])
          .map((c) => `<option value="${c.id}">${c.nome}</option>`)
          .join("");
    }
  } catch (_) {}
  // Produtos
  try {
    const { data: prods } = await supa
      .from("produtos")
      .select("id, nome")
      .order("nome");
    const selProd = document.getElementById("mens-plano-prod-sel");
    if (selProd) {
      selProd.innerHTML =
        '<option value="">— Selecione do cardápio —</option>' +
        (prods || [])
          .map((p) => `<option value="${p.id}">${p.nome}</option>`)
          .join("");
      selProd.onchange = function () {
        const nome = this.options[this.selectedIndex]?.text || "";
        const inp = document.getElementById("mens-plano-produto");
        if (inp && nome && nome !== "— Selecione do cardápio —")
          inp.value = nome;
      };
    }
  } catch (_) {}
}

async function mensAbrirModalPlano(id = null) {
  const p = id ? _mensPlanos.find((x) => x.id === id) : null;
  document.getElementById("mens-plano-id").value = p?.id || "";
  document.getElementById("mens-plano-cli-id").value = p?.cliente_id || "";
  document.getElementById("mens-plano-produto").value = p?.produto || "";
  document.getElementById("mens-plano-qtd").value = p?.qtd_total || "";
  document.getElementById("mens-plano-valor").value = p?.valor || "";
  document.getElementById("mens-plano-ini").value =
    p?.data_inicio?.split("T")[0] || "";
  document.getElementById("mens-plano-fim").value =
    p?.data_fim?.split("T")[0] || "";
  document.getElementById("mens-plano-ativo").checked = p
    ? (p.ativo ?? true)
    : true;
  if (p?.cliente_id) {
    const sel = document.getElementById("mens-plano-cli-sel");
    if (sel) sel.value = p.cliente_id;
  }
  const renovInfo = document.getElementById("mens-renov-info");
  if (renovInfo && p) {
    renovInfo.innerHTML = `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;font-size:0.8rem;margin-bottom:14px">
      Usados: <b>${p.qtd_usada || 0}</b> / ${p.qtd_total || 0} itens
    </div>`;
  } else if (renovInfo) {
    renovInfo.innerHTML = "";
  }
  await _mensPopularSelects();
  const modal = document.getElementById("modal-mens-plano");
  if (modal) modal.style.display = "flex";
}

async function mensSalvarPlano() {
  const id = document.getElementById("mens-plano-id").value;
  const cliSel = document.getElementById("mens-plano-cli-sel")?.value;
  const cliId = cliSel || document.getElementById("mens-plano-cli-id").value;
  const produto = document.getElementById("mens-plano-produto").value.trim();
  const qtd = parseInt(document.getElementById("mens-plano-qtd").value) || 0;
  const valor =
    parseFloat(document.getElementById("mens-plano-valor").value) || 0;
  if (!cliId) {
    alert("⚠️ Selecione o cliente.");
    return;
  }
  if (!produto) {
    alert("⚠️ Informe o produto.");
    return;
  }
  if (qtd <= 0) {
    alert("⚠️ Quantidade inválida.");
    return;
  }
  const dados = {
    cliente_id: parseInt(cliId),
    produto,
    qtd_total: qtd,
    valor,
    data_inicio: document.getElementById("mens-plano-ini").value || null,
    data_fim: document.getElementById("mens-plano-fim").value || null,
    ativo: document.getElementById("mens-plano-ativo").checked,
    ...(id ? {} : { qtd_usada: 0 }),
  };
  try {
    if (id) {
      await supa.from("planos_mensalistas").update(dados).eq("id", id);
    } else {
      await supa.from("planos_mensalistas").insert([dados]);
    }
    fecharModal("modal-mens-plano");
    await _mensCarregarPlanos();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

function mensAbrirEntrega(planoId) {
  const p = _mensPlanos.find((x) => x.id === planoId);
  if (!p) return;
  document.getElementById("mens-ent-plano-id").value = planoId;
  document.getElementById("mens-ent-cliente").textContent =
    p.clientes?.nome || "—";
  document.getElementById("mens-ent-tel").textContent =
    p.clientes?.telefone || "";
  document.getElementById("mens-ent-produto").textContent = p.produto || "—";
  const rest = (p.qtd_total || 0) - (p.qtd_usada || 0);
  document.getElementById("mens-ent-saldo").textContent = `${rest} disponíveis`;
  const valorUnit = p.qtd_total > 0 ? Math.round(p.valor / p.qtd_total) : 0;
  document.getElementById("mens-ent-valor-unit").textContent =
    valorUnit > 0 ? `Gs ${valorUnit.toLocaleString("es-PY")}/item` : "";
  document.getElementById("mens-ent-qtd").value = 1;
  document.getElementById("mens-ent-obs").value = "";
  const modal = document.getElementById("modal-mens-entrega");
  if (modal) modal.style.display = "flex";
}

async function mensSalvarEntrega() {
  const planoId = parseInt(document.getElementById("mens-ent-plano-id").value);
  const qtd = parseInt(document.getElementById("mens-ent-qtd").value) || 1;
  const obs = document.getElementById("mens-ent-obs").value.trim();
  const plano = _mensPlanos.find((p) => p.id === planoId);
  if (!plano) return;
  const restante = (plano.qtd_total || 0) - (plano.qtd_usada || 0);
  if (qtd > restante) {
    alert(`⚠️ Só restam ${restante} itens no plano.`);
    return;
  }
  try {
    const novaUsada = (plano.qtd_usada || 0) + qtd;
    await supa
      .from("planos_mensalistas")
      .update({ qtd_usada: novaUsada })
      .eq("id", planoId);
    // Registra no histórico se a tabela existir
    try {
      await supa.from("planos_entregas").insert([
        {
          plano_id: planoId,
          cliente_id: plano.cliente_id,
          qtd,
          obs,
          data: new Date().toISOString(),
        },
      ]);
    } catch (_) {
      /* tabela pode não existir */
    }
    fecharModal("modal-mens-entrega");
    await _mensCarregarPlanos();
    alert(`✅ ${qtd} item(s) entregue(s) com sucesso!`);
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function mensAbrirHistorico(planoId) {
  const p = _mensPlanos.find((x) => x.id === planoId);
  const modal = document.getElementById("modal-mens-hist");
  if (!modal) return;
  document.getElementById("mens-hist-nome").textContent =
    p?.clientes?.nome || "—";
  document.getElementById("mens-hist-produto").textContent = p?.produto || "—";
  document.getElementById("mens-hist-plano-total").textContent =
    p?.qtd_total || 0;
  const rest = (p?.qtd_total || 0) - (p?.qtd_usada || 0);
  document.getElementById("mens-hist-plano-rest").textContent = rest;
  document.getElementById("mens-hist-entregues").textContent =
    p?.qtd_usada || 0;
  modal.style.display = "flex";
  const tbody = document.getElementById("mens-hist-tbody");
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Carregando...</td></tr>';
  try {
    const { data } = await supa
      .from("planos_entregas")
      .select("*")
      .eq("plano_id", planoId)
      .order("data", { ascending: false });
    tbody.innerHTML = (data || []).length
      ? (data || [])
          .map(
            (e) => `<tr>
          <td style="padding:8px 6px">${new Date(e.data).toLocaleDateString("pt-BR")}</td>
          <td style="text-align:center;padding:8px 6px;font-weight:700">${e.qtd}</td>
          <td style="padding:8px 6px;color:#6b7280">${e.obs || "—"}</td>
          <td style="text-align:center;padding:8px 6px">—</td>
        </tr>`,
          )
          .join("")
      : '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Nenhuma entrega registrada</td></tr>';
  } catch (_) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Histórico não disponível</td></tr>';
  }
}

// ===== RENDERIZAR GRÁFICO COM CHART.JS =====
function renderizarGrafico(labels, data, cores) {
  const canvas = document.getElementById("canvas-grafico");
  if (!canvas) {
    console.error("Canvas do gráfico não encontrado");
    return;
  }

  const ctx = canvas.getContext("2d");

  // Destroi gráfico anterior se existir
  if (graficoInstance) {
    graficoInstance.destroy();
  }

  // Cria novo gráfico
  graficoInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Vendas (Gs)",
          data: data,
          backgroundColor: cores,
          borderWidth: 0,
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return "Gs " + context.parsed.y.toLocaleString("es-PY");
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function (value) {
              return "Gs " + (value / 1000).toFixed(0) + "k";
            },
          },
        },
        x: {
          grid: {
            display: false,
          },
        },
      },
    },
  });
}

// ===== FECHAR MODAL (se não existir função genérica) =====
if (typeof fecharModal !== "function") {
  function fecharModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.style.display = "none";
    }
  }
}
/* ══════════════════════════════════════════════════════════════
   HELPERS ESTOQUE + PDV
   ══════════════════════════════════════════════════════════════ */

// Categorias/tipos que NÃO vão para a cozinha (servido imediatamente)
const _TIPOS_SEM_COZINHA = ["acai", "shake", "suco", "sorvete"];

function _todosSemCozinha(itens) {
  if (!itens || !itens.length) return false;
  return itens.every((i) => {
    const cat = (i.categoria_slug || "").toLowerCase();
    const tipo = i._tipo || "";
    return _TIPOS_SEM_COZINHA.some(
      (t) =>
        cat.includes(t) ||
        tipo === t ||
        cat.includes("bebida") ||
        cat.includes("drink"),
    );
  });
}

// Alias mantido para compatibilidade com código existente
function _todosBebidas(itens) {
  return _todosSemCozinha(itens);
}

// Desconta estoque a partir de uma lista de itens (para UPDATE de mesa)
// CORREÇÃO: agora também desconta produtos que controlam estoque via
// produtos.estoque_qtd (não só via inventario_id) — ver nota em
// _descontarEstoqueVenda() acima para o contexto completo do bug.
// Desconta contando os itens do carrinho

/* ══════════════════════════════════════════════════════════════
   COMBOS — expande itens de combo em "pseudo-itens" dos produtos
   componentes, para que a baixa de estoque (e a reposição no
   cancelamento) funcionem sem precisar duplicar lógica em cada
   função. Itens que não são combo passam direto, sem alteração.
   Idempotente: pode ser chamada mais de uma vez sem efeito colateral.
   ══════════════════════════════════════════════════════════════ */
async function _expandirItensCombo(itens) {
  if (!itens?.length) return itens;

  const combosSemComponentesIds = new Set();
  itens.forEach((item) => {
    const ehCombo = item.tipo_produto === "combo" || item.eh_combo === true;
    const jaTemComponentes = Array.isArray(item.combo_componentes) && item.combo_componentes.length > 0;
    if (ehCombo && !jaTemComponentes) {
      const pid = Number(item.produto_id || item.id);
      if (pid) combosSemComponentesIds.add(pid);
    }
  });

  let componentesPorCombo = {};
  if (combosSemComponentesIds.size) {
    const { data } = await supa
      .from("combo_componentes")
      .select("combo_produto_id, componente_produto_id, quantidade, unidade")
      .in("combo_produto_id", [...combosSemComponentesIds]);
    (data || []).forEach((c) => {
      (componentesPorCombo[c.combo_produto_id] ||= []).push(c);
    });
  }

  const resultado = [];
  itens.forEach((item) => {
    const ehCombo = item.tipo_produto === "combo" || item.eh_combo === true;
    if (!ehCombo) {
      resultado.push(item);
      return;
    }

    const qtdVendida = parseInt(item.qtd || item.q || 1) || 1;
    const componentes =
      Array.isArray(item.combo_componentes) && item.combo_componentes.length
        ? item.combo_componentes
        : (componentesPorCombo[Number(item.produto_id || item.id)] || []).map((c) => ({
            componente_produto_id: c.componente_produto_id,
            quantidade: c.quantidade,
            variacao_id: null,
          }));

    componentes.forEach((c) => {
      const qtdTotal = Math.round((parseFloat(c.quantidade) || 0) * qtdVendida * 100) / 100;
      if (qtdTotal <= 0) return;
      resultado.push({
        produto_id: c.componente_produto_id,
        id: c.componente_produto_id,
        qtd: qtdTotal,
        variacao_id: c.variacao_id || null,
        _origemCombo: true,
      });
    });
  });

  return resultado;
}

async function _descontarEstoqueVendaItens(itens) {
  try {
    if (!itens?.length) return;
    itens = await _expandirItensCombo(itens);
    if (!itens?.length) return;

    // 1. Desconta variações individuais (via RPC)
    for (const item of itens) {
      const variacaoId = item.variacao_id || item.variacaoId || null;
      const qtd = parseInt(item.qtd || item.q || 1) || 1;
      if (variacaoId) {
        console.log(`🔄 Descontando variação ${variacaoId}, qtd ${qtd}`);
        // Chama a função RPC que decrementa com lock
        const { data, error } = await supa.rpc('decrementar_estoque_variacao', {
          p_variacao_id: variacaoId,
          p_quantidade: qtd
        });
        if (error) {
          console.warn(`Erro ao descontar variação ${variacaoId}:`, error);
        } else if (data && !data.ok) {
          console.warn(`Estoque insuficiente para variação ${variacaoId}:`, data.erro);
        }
      }
    }

    // 2. Desconta estoque total do produto (estoque_qtd)
    // Agrupa por produto_id
    const prodQtdMap = {};
    itens.forEach(item => {
      const prodId = item.produto_id || item.id;
      if (!prodId) return;
      const qtd = parseInt(item.qtd || item.q || 1) || 1;
      prodQtdMap[prodId] = (prodQtdMap[prodId] || 0) + qtd;
    });

    const prodIds = Object.keys(prodQtdMap).map(Number);
    if (prodIds.length) {
      // Busca produtos com estoque_qtd (que não sejam apenas inventario_id)
      const { data: prods } = await supa
        .from('produtos')
        .select('id, estoque_qtd, inventario_id')
        .in('id', prodIds);

      for (const prod of prods || []) {
        const qtdVendida = prodQtdMap[prod.id] || 0;
        if (prod.estoque_qtd !== null && prod.estoque_qtd !== undefined) {
          // Desconta do estoque direto do produto
          const novaQtd = Math.max(0, (prod.estoque_qtd || 0) - qtdVendida);
          await supa
            .from('produtos')
            .update({ estoque_qtd: novaQtd })
            .eq('id', prod.id);

          // Auto-pause se zerou (opcional)
          if (novaQtd === 0) {
            await supa
              .from('produtos')
              .update({ ativo: false })
              .eq('id', prod.id);
          }
        }

        // Se o produto tem inventario_id, desconta também do inventário
        if (prod.inventario_id) {
          const { data: estoque } = await supa
            .from('inventario')
            .select('quantidade')
            .eq('id', prod.inventario_id)
            .single();
          if (estoque) {
            const novaQtd = Math.max(0, (estoque.quantidade || 0) - qtdVendida);
            await supa
              .from('inventario')
              .update({ quantidade: novaQtd })
              .eq('id', prod.inventario_id);
            // Registra movimento
            await supa
              .from('inventario_movimentos')
              .insert([{
                inventario_id: prod.inventario_id,
                tipo: 'sub',
                quantidade: qtdVendida,
                motivo: 'Venda PDV (balcão)',
                usuario_email: 'sistema'
              }])
              .then(() => {})
              .catch(() => {});
          }
        }
      }
    }

    console.log(`✅ Estoque descontado: ${itens.length} itens`);
  } catch (e) {
    console.warn('Erro ao descontar estoque (itens):', e.message);
  }
}

// Desconta estoque a partir de pedidoId OU lista de itens
//
// CORREÇÃO IMPORTANTE: o sistema tem DOIS mecanismos de controle de estoque
// que não se comunicavam:
//   1) produtos.inventario_id → tabela `inventario` (estoque vinculado/insumo)
//   2) produtos.estoque_qtd   → controle direto na própria linha do produto
//      (usado pela tela "Gestão de Estoque" / cadastro de produto simples)
// A função antiga só descontava (1), então produtos cadastrados com (2)
// — como a maioria dos produtos simples — nunca tinham o estoque baixado.
// Agora a função verifica e desconta em AMBOS, dependendo de qual campo
// o produto usa.
async function _descontarEstoqueVenda(pedidoId, itensDireto) {
  try {
    let itens = itensDireto;
    if (!itens) {
      const { data: pedido } = await supa
        .from("pedidos")
        .select("itens")
        .eq("id", pedidoId)
        .single();
      itens = pedido?.itens;
    }
    if (!itens?.length) return;

    // Expande combos em pseudo-itens dos produtos componentes ANTES de
    // qualquer baixa — assim tanto a etapa 1 (variações) quanto a 2
    // (estoque_qtd/inventario) abaixo já operam sobre os componentes reais.
    itens = await _expandirItensCombo(itens);
    if (!itens?.length) return;

    // ------------------------------------------------------------
    // 1. Desconta o estoque de TODOS os itens da venda.
    //    _descontarEstoqueVendaItens() já cuida de tudo sozinha:
    //    variação (via RPC), estoque_qtd direto do produto, E
    //    inventário vinculado (inventario_id) — para qualquer item,
    //    com ou sem variação. Não é preciso (nem deve) repetir essa
    //    baixa aqui embaixo.
    // ------------------------------------------------------------
    await _descontarEstoqueVendaItens(itens);

    console.log(`✅ Estoque descontado: pedido ${pedidoId || "(PDV)"}, ${itens.length} item(s)`);

    // ⚠️ REMOVIDO: bloco duplicado que descontava estoque_qtd/inventario
    // NOVAMENTE aqui para os itens sem variação — causava baixa em DOBRO
    // em toda venda de produto simples, já que _descontarEstoqueVendaItens()
    // logo acima já faz exatamente essa mesma baixa para todos os itens
    // (com ou sem variação).

    // ⚠️ REMOVIDO: chamada a atualizar_estoque_total_produto_manual().
    // Essa chamada existia no código mas ficava após um bug de escopo
    // que a impedia de rodar (ver histórico) — ou seja, nunca havia
    // sido executada de fato. Ao corrigir o bug de escopo, ela passou
    // a rodar e zerou o estoque de produtos sem variação (a função do
    // banco parece recalcular o total a partir de produto_variacoes,
    // que fica vazio para produtos com controle direto de estoque).
    // A baixa de estoque já é feita corretamente logo acima, sem
    // depender dessa função — por isso ela foi retirada daqui.
  } catch (e) {
    console.warn("_descontarEstoqueVenda:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   BUG #7 CORRIGIDO — Repõe estoque quando um pedido é cancelado
   ══════════════════════════════════════════════════════════════ */
// CORREÇÃO: repõe estoque tanto via inventario_id quanto via estoque_qtd
// (mesmo bug do desconto na venda existia aqui — produtos cadastrados com
// controle direto em produtos.estoque_qtd nunca recebiam a reposição).
async function _reporEstoqueCancelamento(pedidoId) {
  try {
    const { data: pedido } = await supa
      .from("pedidos")
      .select("itens")
      .eq("id", pedidoId)
      .single();
    let itens = pedido?.itens;
    if (!itens?.length) return;

    // Expande combos em pseudo-itens dos componentes, para repor o
    // estoque correto (garrafa de whiskey, gelo, etc.) em vez do combo em si.
    itens = await _expandirItensCombo(itens);
    if (!itens?.length) return;

    // ── Repõe variações (contra-parte do decrementar_estoque_variacao) ──
    const itensComVariacao = itens.filter((i) => i.variacao_id);
    for (const item of itensComVariacao) {
      const qtd = parseInt(item.qtd || item.q || 1) || 1;
      await supa.rpc("incrementar_estoque_variacao", {
        p_variacao_id: item.variacao_id,
        p_quantidade: qtd,
      }).then(() => {}).catch((e) => console.warn("incrementar_estoque_variacao:", e.message));
    }
    const itensSemVariacao = itens.filter((i) => !i.variacao_id);
    if (!itensSemVariacao.length) {
      console.log(`✅ Estoque reposto (variações): pedido cancelado #${pedidoId}`);
      return;
    }

    const prodIds = [
      ...new Set(itensSemVariacao.map((i) => i.produto_id || i.id).filter(Boolean)),
    ];
    if (!prodIds.length) return;

    const { data: prods } = await supa
      .from("produtos")
      .select("id, inventario_id, estoque_qtd")
      .in("id", prodIds);
    if (!prods?.length) return;

    const qtdPorProduto = {};
    itensSemVariacao.forEach((item) => {
      const pid = Number(item.produto_id || item.id);
      if (!pid) return;
      qtdPorProduto[pid] = (qtdPorProduto[pid] || 0) + (item.qtd || item.q || 1);
    });

    // ── Caminho 1: inventario_id ──────────────────────────────────────
    const reposicoes = {};
    prods.forEach((prod) => {
      if (!prod.inventario_id) return;
      const qtd = qtdPorProduto[prod.id];
      if (!qtd) return;
      reposicoes[prod.inventario_id] = (reposicoes[prod.inventario_id] || 0) + qtd;
    });

    if (Object.keys(reposicoes).length > 0) {
      const invIds = Object.keys(reposicoes).map(Number);
      const { data: estoques } = await supa
        .from("inventario")
        .select("id, quantidade")
        .in("id", invIds);
      for (const est of estoques || []) {
        const nova = (est.quantidade ?? 0) + reposicoes[est.id];
        await supa.from("inventario").update({ quantidade: nova }).eq("id", est.id);
        await supa
          .from("inventario_movimentos")
          .insert([{
            inventario_id: est.id,
            tipo: "ajuste",
            quantidade: reposicoes[est.id],
            motivo: `Cancelamento — Pedido #${pedidoId}`,
            usuario_email: "sistema",
          }])
          .then(() => {})
          .catch(() => {});
      }
    }

    // ── Caminho 2: estoque_qtd direto no produto ─────────────────────
    const produtosComEstoqueQtd = prods.filter(
      (p) => p.estoque_qtd !== null && p.estoque_qtd !== undefined,
    );
    for (const prod of produtosComEstoqueQtd) {
      const qtd = qtdPorProduto[prod.id];
      if (!qtd) continue;
      const novaQtd = (prod.estoque_qtd || 0) + qtd;
      await supa.from("produtos").update({ estoque_qtd: novaQtd }).eq("id", prod.id);
    }
    console.log(`✅ Estoque reposto: pedido cancelado #${pedidoId}`);
  } catch (e) {
    console.warn("_reporEstoqueCancelamento:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   CASHBACK — Geração e uso de crédito de clientes.
   Estas funções eram chamadas em salvarPedidoBalcao() mas nunca
   haviam sido definidas (ReferenceError, quebrava a finalização
   da venda logo após o pedido já ter sido salvo no banco).
   ══════════════════════════════════════════════════════════════ */

/**
 * Gera cashback (crédito) para o cliente com base no valor da venda,
 * usando o percentual e validade configurados em CRM > Configurações.
 */
async function crmGerarCashback(telefone, valorVenda, pedidoId = null) {
  try {
    if (!telefone || !valorVenda || valorVenda <= 0) return;

    const pct = typeof _crmCashbackPct === "number" ? _crmCashbackPct : 2;
    const validadeDias = typeof _crmCashbackVal === "number" ? _crmCashbackVal : 30;
    if (pct <= 0) return;

    const valorCashback = Math.round(valorVenda * (pct / 100));
    if (valorCashback <= 0) return;

    const { data: cliente } = await supa
      .from("clientes")
      .select("id, cashback_saldo")
      .eq("telefone", telefone)
      .maybeSingle();

    await supa.from("cashback_transacoes").insert([{
      cliente_id: cliente?.id || null,
      cliente_telefone: telefone,
      pedido_id: pedidoId,
      tipo: "credito",
      valor: valorCashback,
      validade_dias: validadeDias,
      usado: false,
    }]);

    if (cliente?.id) {
      const novoSaldo = (cliente.cashback_saldo || 0) + valorCashback;
      await supa.from("clientes").update({ cashback_saldo: novoSaldo }).eq("id", cliente.id);
    }
    console.log(`✅ Cashback gerado: Gs ${valorCashback} para ${telefone}`);
  } catch (e) {
    console.warn("crmGerarCashback:", e.message);
  }
}

/**
 * Debita cashback do saldo do cliente ao ser usado como desconto numa venda.
 */
async function crmUsarCashback(telefone, valorUsado) {
  try {
    if (!telefone || !valorUsado || valorUsado <= 0) return;

    const { data: cliente } = await supa
      .from("clientes")
      .select("id, cashback_saldo")
      .eq("telefone", telefone)
      .maybeSingle();
    if (!cliente) return;

    await supa.from("cashback_transacoes").insert([{
      cliente_id: cliente.id,
      cliente_telefone: telefone,
      tipo: "debito",
      valor: valorUsado,
      validade_dias: 0,
      usado: true,
    }]);

    const novoSaldo = Math.max(0, (cliente.cashback_saldo || 0) - valorUsado);
    await supa.from("clientes").update({ cashback_saldo: novoSaldo }).eq("id", cliente.id);
    console.log(`✅ Cashback usado: Gs ${valorUsado} de ${telefone}`);
  } catch (e) {
    console.warn("crmUsarCashback:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   BUG #6 CORRIGIDO — Estorna cashback gerado ao cancelar pedido.
   Busca a transação de crédito vinculada ao pedido e:
   1. Insere um débito igual para zerar o saldo.
   2. Atualiza clientes.cashback_saldo subtraindo o valor.
   ══════════════════════════════════════════════════════════════ */
async function _estornarCashbackCancelamento(pedidoId) {
  try {
    const { data: txs } = await supa
      .from("cashback_transacoes")
      .select("id, cliente_id, cliente_telefone, valor")
      .eq("pedido_id", pedidoId)
      .eq("tipo", "credito")
      .eq("usado", false); // só estorna crédito ainda não utilizado

    if (!txs?.length) return;

    for (const tx of txs) {
      // Marca a transação original como estornada
      await supa
        .from("cashback_transacoes")
        .update({ usado: true })
        .eq("id", tx.id);

      // Insere débito de estorno
      await supa.from("cashback_transacoes").insert([{
        cliente_id:       tx.cliente_id,
        cliente_telefone: tx.cliente_telefone,
        pedido_id:        pedidoId,
        tipo:             "debito",
        valor:            tx.valor,
        validade_dias:    0,
        usado:            true,
      }]);

      // Atualiza saldo do cliente
      if (tx.cliente_id) {
        const { data: cli } = await supa
          .from("clientes")
          .select("cashback_saldo")
          .eq("id", tx.cliente_id)
          .single();
        if (cli) {
          const novoSaldo = Math.max(0, (cli.cashback_saldo || 0) - tx.valor);
          await supa
            .from("clientes")
            .update({ cashback_saldo: novoSaldo })
            .eq("id", tx.cliente_id);
        }
      }
      console.log(`✅ Cashback estornado: Gs ${tx.valor} — pedido #${pedidoId}`);
    }
  } catch (e) {
    console.warn("_estornarCashbackCancelamento:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR RETRÁTIL (desktop)
   ══════════════════════════════════════════════════════════════ */
function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const main = document.querySelector(".main-content");
  const btn = document.getElementById("btn-toggle-sidebar");
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle("collapsed");
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  if (btn)
    btn.innerHTML = collapsed
      ? '<i class="fas fa-bars"></i>'
      : '<i class="fas fa-chevron-left"></i>';
  localStorage.setItem("app_sidebar_collapsed", collapsed ? "1" : "0");
}

// Restaura estado da sidebar ao carregar
document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("app_sidebar_collapsed") === "1") {
    document.querySelector(".sidebar")?.classList.add("collapsed");
    document.body.classList.add("sidebar-collapsed");
    const btn = document.getElementById("btn-toggle-sidebar");
    if (btn) btn.innerHTML = '<i class="fas fa-bars"></i>';
  }
});

/* ══════════════════════════════════════════════════════════════
   MANIFEST DINÂMICO
   ══════════════════════════════════════════════════════════════ */
function _atualizarManifestDinamico(logoUrl) {
  try {
    const manifest = {
      name: NOME_RESTAURANTE || "Restaurante",
      short_name: NOME_RESTAURANTE || "App",
      description: "Sistema de pedidos online",
      start_url: "/index.html",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: "#1d1d1d",
      icons: [
        {
          src: logoUrl,
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: logoUrl,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    };
    const blob = new Blob([JSON.stringify(manifest)], {
      type: "application/manifest+json",
    });
    let el = document.querySelector('link[rel="manifest"]');
    if (!el) {
      el = document.createElement("link");
      el.rel = "manifest";
      document.head.appendChild(el);
    }
    el.href = URL.createObjectURL(blob);
    console.log("✅ Manifest atualizado");
  } catch (e) {
    console.warn("Manifest:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   INVENTÁRIO — Card Layout
   ══════════════════════════════════════════════════════════════ */
let _inventarioItems = [];
let _tipoAjuste = "add";

async function carregarInventario() {
  if (
    perfilUsuario !== "dono" &&
    perfilUsuario !== "gerente" &&
    perfilUsuario !== "adminMaster"
  )
    return;
  const container = document.getElementById("inventario-lista");
  if (!container) return;
  container.innerHTML =
    '<div style="text-align:center;padding:30px;color:#aaa"><i class="fas fa-spinner fa-spin"></i></div>';
  const { data, error } = await supa
    .from("inventario")
    .select(
      "id, nome, quantidade, unidade, quantidade_minima, observacoes, produto_id, perecivel, data_validade, produtos!inventario_produto_id_fkey(nome)",
    )
    .order("nome");
  if (error) {
    const { data: d2 } = await supa
      .from("inventario")
      .select("*")
      .order("nome");
    _inventarioItems = (d2 || []).map((i) => ({ ...i, produtos: null }));
  } else {
    _inventarioItems = data || [];
  }
  _renderInventarioCards();
  _verificarAlertasEstoque();
}

function _renderInventarioCards() {
  const container = document.getElementById("inventario-lista");
  if (!container) return;
  if (!_inventarioItems.length) {
    container.innerHTML =
      '<div style="text-align:center;padding:40px;color:#aaa">Nenhum item. Clique em "+ Novo Item".</div>';
    return;
  }
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  container.innerHTML = _inventarioItems
    .map((item) => {
      const qtd = item.quantidade ?? 0;
      const min = item.quantidade_minima ?? 0;
      let bg = "",
        badgeStyle = "",
        badgeText = "";
      if (qtd <= 0) {
        bg = "#fff5f5";
        badgeStyle = "background:#fee2e2;color:#dc2626";
        badgeText = "🔴 Zerado";
      } else if (min > 0 && qtd <= min) {
        bg = "#fffbeb";
        badgeStyle = "background:#fef3c7;color:#d97706";
        badgeText = "⚠️ Baixo";
      } else {
        badgeStyle = "background:#dcfce7;color:#16a34a";
        badgeText = "✅ OK";
      }
      let validadeHtml = "";
      if (item.perecivel && item.data_validade) {
        const val = new Date(item.data_validade);
        val.setHours(0, 0, 0, 0);
        const dias = Math.ceil((val - hoje) / 86400000);
        if (dias < 0) {
          validadeHtml = `<span style="font-size:0.72rem;color:#dc2626;font-weight:600">🚫 VENCIDO</span>`;
          bg = "#fff0f0";
        } else if (dias <= 20) {
          validadeHtml = `<span style="font-size:0.72rem;color:#d97706;font-weight:600">⏰ Vence em ${dias}d</span>`;
          if (!bg) bg = "#fffbeb";
        } else
          validadeHtml = `<span style="font-size:0.72rem;color:#888">📅 Val: ${new Date(item.data_validade).toLocaleDateString("pt-BR")}</span>`;
      }
      const prodNome = item.produtos
        ? `<span style="font-size:0.72rem;background:#e8f4fd;color:#1a6eb5;padding:2px 8px;border-radius:10px">${item.produtos.nome}</span>`
        : "";
      const nEsc = (item.nome || "").replace(/'/g, "\\'");
      const qtdColor =
        qtd <= 0 ? "#dc2626" : min > 0 && qtd <= min ? "#d97706" : "#16a34a";
      return `<div class="inv-card" style="background:${bg}" data-id="${item.id}" data-nome="${(item.nome || "").replace(/"/g, "&quot;")}" data-status="${qtd <= 0 ? "zerado" : min > 0 && qtd <= min ? "baixo" : "ok"}">
      <div class="inv-card-top">
        <div class="inv-card-nome">${item.nome || ""}${item.perecivel ? " 🥛" : ""}${validadeHtml ? "<br>" + validadeHtml : ""}${item.observacoes ? `<br><small style="color:#888;font-weight:400">${item.observacoes}</small>` : ""}</div>
        <span class="inv-card-status-badge" style="${badgeStyle}">${badgeText}</span>
      </div>
      <div class="inv-card-row">
        <div><div class="inv-card-info">Unid: <strong>${item.unidade || "un"}</strong>${min > 0 ? ` · Mín: ${min}` : ""}</div>${prodNome}</div>
        <div class="inv-qtd-controls">
          <button class="inv-qtd-btn minus" onclick="ajusteRapido(${item.id},'sub','${nEsc}',${qtd})">−</button>
          <span class="inv-qtd-val" style="color:${qtdColor}">${qtd}</span>
          <button class="inv-qtd-btn plus" onclick="ajusteRapido(${item.id},'add','${nEsc}',${qtd})">+</button>
        </div>
      </div>
      <div class="inv-card-actions">
        <button style="background:#f59e0b;color:#fff" onclick="abrirModalInventario(${item.id})">✏️ Editar</button>
        <button style="background:#fee2e2;color:#dc2626" onclick="excluirInventario(${item.id})">🗑️</button>
      </div>
    </div>`;
    })
    .join("");
}

function filtrarInventario() {
  const busca = (
    document.getElementById("inv-busca")?.value || ""
  ).toLowerCase();
  const status = document.getElementById("inv-filtro-status")?.value || "";
  document
    .querySelectorAll("#inventario-lista .inv-card[data-id]")
    .forEach((card) => {
      const m1 =
        !busca || (card.dataset.nome || "").toLowerCase().includes(busca);
      const m2 = !status || card.dataset.status === status;
      card.style.display = m1 && m2 ? "" : "none";
    });
}

function _verificarAlertasEstoque() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const alertas = [];
  _inventarioItems.forEach((i) => {
    const q = i.quantidade ?? 0,
      m = i.quantidade_minima ?? 0;
    if (q <= 0) alertas.push(`${i.nome} (zerado)`);
    else if (m > 0 && q <= m)
      alertas.push(`${i.nome} (${q} ${i.unidade || "un"})`);
    if (i.perecivel && i.data_validade) {
      // Não alertar validade se item sem estoque
      if (q > 0) {
        const val = new Date(i.data_validade);
        val.setHours(0, 0, 0, 0);
        const dias = Math.ceil((val - hoje) / 86400000);
        if (dias <= 20)
          alertas.push(
            `${i.nome} vence ${dias <= 0 ? "VENCIDO" : "em " + dias + "d"}`,
          );
      }
    }
  });
  const el = document.getElementById("alerta-estoque-baixo");
  const li = document.getElementById("alerta-estoque-lista");
  if (!el) return;
  if (alertas.length) {
    el.style.display = "block";
    li.textContent = alertas.join(" • ");
  } else el.style.display = "none";
}

function ajusteRapido(id, tipo, nome, qtdAtual) {
  abrirModalAjuste(id, nome, qtdAtual);
  setTipoAjuste(tipo);
}

async function abrirModalInventario(id = null) {
  document.getElementById("inv-id").value = id || "";
  ["inv-nome", "inv-qtd", "inv-minimo", "inv-obs", "inv-validade"].forEach(
    (i) => {
      const el = document.getElementById(i);
      if (el) el.value = "";
    },
  );
  const per = document.getElementById("inv-perecivel");
  if (per) per.checked = false;
  const valA = document.getElementById("inv-validade-area");
  if (valA) valA.style.display = "none";
  document.getElementById("inv-unidade").value = "un";
  document.getElementById("inv-produto-id").innerHTML =
    '<option value="">— Sem vínculo —</option>';
  document.getElementById("modal-inv-titulo").textContent = id
    ? "✏️ Editar Item"
    : "📦 Novo Item de Estoque";
  const { data: prods } = await supa
    .from("produtos")
    .select("id, nome")
    .eq("ativo", true)
    .order("nome");
  if (prods) {
    const sel = document.getElementById("inv-produto-id");
    prods.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.nome;
      sel.appendChild(o);
    });
  }
  if (id) {
    const item = _inventarioItems.find((i) => i.id === id);
    if (item) {
      document.getElementById("inv-nome").value = item.nome || "";
      document.getElementById("inv-qtd").value = item.quantidade ?? "";
      document.getElementById("inv-unidade").value = item.unidade || "un";
      document.getElementById("inv-minimo").value =
        item.quantidade_minima ?? "";
      document.getElementById("inv-obs").value = item.observacoes || "";
      if (item.produto_id)
        document.getElementById("inv-produto-id").value = item.produto_id;
      if (item.perecivel && per) {
        per.checked = true;
        if (valA) valA.style.display = "block";
        const vi = document.getElementById("inv-validade");
        if (vi && item.data_validade)
          vi.value = item.data_validade.split("T")[0];
      }
    }
  }
  document.getElementById("modal-inventario").style.display = "flex";
}

function togglePerecivel() {
  const c = document.getElementById("inv-perecivel")?.checked;
  const a = document.getElementById("inv-validade-area");
  if (a) a.style.display = c ? "block" : "none";
}

async function salvarInventario() {
  const id = document.getElementById("inv-id").value;
  const nome = document.getElementById("inv-nome").value.trim();
  if (!nome) {
    alert("Informe o nome do item.");
    return;
  }
  const perecivel = document.getElementById("inv-perecivel")?.checked || false;
  const dados = {
    nome,
    quantidade: parseFloat(document.getElementById("inv-qtd").value) || 0,
    unidade: document.getElementById("inv-unidade").value,
    quantidade_minima:
      parseFloat(document.getElementById("inv-minimo").value) || null,
    observacoes: document.getElementById("inv-obs").value.trim() || null,
    produto_id:
      parseInt(document.getElementById("inv-produto-id").value) || null,
    perecivel,
    data_validade:
      perecivel && document.getElementById("inv-validade").value
        ? document.getElementById("inv-validade").value
        : null,
  };
  const { error } = id
    ? await supa.from("inventario").update(dados).eq("id", id)
    : await supa.from("inventario").insert([dados]);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }
  fecharModal("modal-inventario");
  carregarInventario();
}

async function excluirInventario(id) {
  if (!confirm("Excluir este item?")) return;
  await supa.from("inventario").delete().eq("id", id);
  carregarInventario();
}

function setTipoAjuste(tipo) {
  _tipoAjuste = tipo;
  ["add", "sub", "set"].forEach((t) => {
    const btn = document.getElementById(`btn-ajuste-${t}`);
    if (btn) btn.style.opacity = t === tipo ? "1" : "0.5";
  });
  const labels = {
    add: "Quantidade a adicionar",
    sub: "Quantidade a remover",
    set: "Nova quantidade total",
  };
  const el = document.getElementById("ajuste-qtd-label");
  if (el) el.textContent = labels[tipo];
}

function abrirModalAjuste(id, nome, qtdAtual) {
  _tipoAjuste = "add";
  document.getElementById("ajuste-inv-id").value = id;
  document.getElementById("ajuste-inv-nome").textContent =
    `${nome} — Atual: ${qtdAtual}`;
  document.getElementById("ajuste-qtd").value = "";
  document.getElementById("ajuste-motivo").value = "";
  setTipoAjuste("add");
  document.getElementById("modal-ajuste-estoque").style.display = "flex";
}

async function confirmarAjuste() {
  const id = document.getElementById("ajuste-inv-id").value;
  const qtd = parseFloat(document.getElementById("ajuste-qtd").value);
  if (isNaN(qtd) || qtd < 0) {
    alert("Quantidade inválida.");
    return;
  }
  const item = _inventarioItems.find((i) => i.id == id);
  const atual = item ? (item.quantidade ?? 0) : 0;
  const nova =
    _tipoAjuste === "add"
      ? atual + qtd
      : _tipoAjuste === "sub"
        ? Math.max(0, atual - qtd)
        : qtd;
  const { error } = await supa
    .from("inventario")
    .update({ quantidade: nova })
    .eq("id", id);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }
  const motivo = document.getElementById("ajuste-motivo").value.trim();
  const userEmail = (await supa.auth.getUser()).data?.user?.email || "";
  await supa
    .from("inventario_movimentos")
    .insert([
      {
        inventario_id: parseInt(id),
        tipo: _tipoAjuste,
        quantidade: qtd,
        motivo: motivo || null,
        usuario_email: userEmail,
      },
    ])
    .then(() => {})
    .catch(() => {});
  fecharModal("modal-ajuste-estoque");
  carregarInventario();
}

async function _carregarSelectInventario(selectedId = null) {
  const sel = document.getElementById("prod-inventario-id");
  if (!sel) return;
  sel.innerHTML = '<option value="">— Selecione o item —</option>';
  const { data } = await supa
    .from("inventario")
    .select("id, nome, quantidade, unidade")
    .order("nome");
  if (data) {
    data.forEach((i) => {
      const opt = document.createElement("option");
      opt.value = i.id;
      opt.textContent = `${i.nome} (${i.quantidade ?? 0} ${i.unidade || "un"})`;
      if (selectedId && i.id == selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
  }
}

// ── ESTOQUE DIRETO (novo — sem inventário vinculado) ─────────
// ── PRODUTO PERECÍVEL (modal de produto) ─────────────────────
function togglePerecivelFields(on) {
  const area = document.getElementById("perecivel-area");
  if (area) area.style.display = on ? "block" : "none";
  if (!on) {
    const dt = document.getElementById("prod-data-validade");
    if (dt) dt.value = "";
  }
}

function toggleEstoqueDireto(on) {
  const area = document.getElementById("estoque-direto-area");
  if (area) area.style.display = on ? "block" : "none";
}

// Alias de compatibilidade — o modal agora chama toggleEstoqueDireto
function toggleEstoqueProduto() {
  const checked = document.getElementById("prod-tem-estoque")?.checked;
  toggleEstoqueDireto(!!checked);
}

// ── VENDA POR KG ─────────────────────────────────────────────
function toggleVendaKg(on) {
  const area = document.getElementById("venda-kg-area");
  if (area) area.style.display = on ? "block" : "none";
  // Quando Kg ativado, define unidade de venda como "kg" automaticamente
  if (on) {
    const unid = document.getElementById("prod-unidade-venda");
    if (unid) unid.value = "kg";
  }
}

/* ══════════════════════════════════════════════════════════════
   COMBOS / KITS — produtos compostos que descontam estoque de
   outros produtos (fracionado ou por unidade inteira).
   ══════════════════════════════════════════════════════════════ */

// Alterna a interface do modal entre "Produto simples" e "Combo"
function toggleTipoProdutoUI(tipo) {
  const boxSimples = document.getElementById("box-estoque-simples");
  const boxCombo = document.getElementById("box-combo-componentes");
  if (boxSimples) boxSimples.style.display = tipo === "combo" ? "none" : "block";
  if (boxCombo) boxCombo.style.display = tipo === "combo" ? "block" : "none";

  // Combos não têm venda por Kg (isso é um marcador de produto simples)
  const vk = document.getElementById("prod-venda-kg");
  if (tipo === "combo" && vk?.checked) {
    vk.checked = false;
    toggleVendaKg(false);
  }
}

function toggleFracionavel(on) {
  const area = document.getElementById("fracionavel-area");
  if (area) area.style.display = on ? "block" : "none";
}

let _comboRowSeq = 0;

// Adiciona uma linha de componente ao builder do combo.
// `dados` pode vir preenchido ao editar um combo existente.
function comboAdicionarComponente(dados = {}) {
  const lista = document.getElementById("combo-componentes-lista");
  if (!lista) return;

  const rowId = "combo-row-" + ++_comboRowSeq;
  const row = document.createElement("div");
  row.id = rowId;
  row.className = "combo-componente-row";
  row.style.cssText =
    "display:flex;gap:6px;align-items:flex-start;background:#fff;border:1px solid #e9d5ff;border-radius:8px;padding:8px;flex-wrap:wrap";

  // Produtos elegíveis como componente: exclui combos (para não permitir
  // combo dentro de combo) e o próprio produto em edição.
  const idAtual = parseInt(document.getElementById("prod-id")?.value) || null;
  const opcoes = (_todosProdutos || [])
    .filter((p) => p.tipo_produto !== "combo" && p.id !== idAtual)
    .map(
      (p) =>
        `<option value="${p.id}" data-unidade="${p.unidade_fracionamento || "un"}"
           ${dados.componente_produto_id === p.id ? "selected" : ""}>${p.nome}</option>`,
    )
    .join("");

  row.innerHTML = `
    <div style="flex:2;min-width:160px">
      <select class="form-control combo-sel-produto" style="font-size:0.85rem"
        onchange="_comboAtualizarUnidadeLinha('${rowId}')">
        <option value="">— Selecione o produto —</option>
        ${opcoes}
      </select>
    </div>
    <div style="width:90px">
      <input type="number" class="form-control combo-inp-qtd" min="0.01" step="0.01"
        placeholder="Qtd" style="font-size:0.85rem" value="${dados.quantidade ?? ""}">
    </div>
    <div style="width:90px">
      <select class="form-control combo-sel-unidade" style="font-size:0.85rem">
        <option value="ml" ${dados.unidade === "ml" ? "selected" : ""}>ml</option>
        <option value="g" ${dados.unidade === "g" ? "selected" : ""}>g</option>
        <option value="un" ${!dados.unidade || dados.unidade === "un" ? "selected" : ""}>un</option>
      </select>
    </div>
    <label style="display:flex;align-items:center;gap:4px;font-size:0.76rem;color:#555;white-space:nowrap;padding-top:8px">
      <input type="checkbox" class="combo-chk-variacao" ${dados.permite_variacao ? "checked" : ""}>
      Variação na venda
    </label>
    <button type="button" onclick="document.getElementById('${rowId}').remove()"
      style="background:#fee2e2;color:#dc2626;border:none;border-radius:6px;width:30px;height:30px;cursor:pointer;font-weight:700">×</button>
  `;
  lista.appendChild(row);

  // Se já veio com produto+unidade definidos (edição), aplica a unidade sugerida
  if (dados.componente_produto_id) _comboAtualizarUnidadeLinha(rowId, dados.unidade);
}

// Ao escolher um produto componente, sugere automaticamente a unidade
// de fracionamento cadastrada nele (mas permite o usuário sobrescrever).
function _comboAtualizarUnidadeLinha(rowId, forcarUnidade = null) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const sel = row.querySelector(".combo-sel-produto");
  const unidSel = row.querySelector(".combo-sel-unidade");
  if (!sel || !unidSel) return;
  const opt = sel.options[sel.selectedIndex];
  const unidadeSugerida = forcarUnidade || opt?.dataset?.unidade || "un";
  unidSel.value = unidadeSugerida;
}

function comboColetarComponentes() {
  const linhas = document.querySelectorAll("#combo-componentes-lista .combo-componente-row");
  const componentes = [];
  linhas.forEach((row, idx) => {
    const produtoId = parseInt(row.querySelector(".combo-sel-produto")?.value) || null;
    const quantidade = parseFloat(row.querySelector(".combo-inp-qtd")?.value) || 0;
    const unidade = row.querySelector(".combo-sel-unidade")?.value || "un";
    const permiteVariacao = row.querySelector(".combo-chk-variacao")?.checked || false;
    if (produtoId && quantidade > 0) {
      componentes.push({
        componente_produto_id: produtoId,
        quantidade,
        unidade,
        permite_variacao: permiteVariacao,
        ordem: idx,
      });
    }
  });
  return componentes;
}

async function comboSalvarComponentes(comboProdutoId) {
  const componentes = comboColetarComponentes();
  // Substitui a receita inteira (mais simples e evita órfãos)
  await supa.from("combo_componentes").delete().eq("combo_produto_id", comboProdutoId);
  if (componentes.length) {
    await supa.from("combo_componentes").insert(
      componentes.map((c) => ({ ...c, combo_produto_id: comboProdutoId })),
    );
  }
}

async function comboCarregarComponentesParaEdicao(comboProdutoId) {
  const lista = document.getElementById("combo-componentes-lista");
  if (lista) lista.innerHTML = "";
  const { data, error } = await supa
    .from("combo_componentes")
    .select("componente_produto_id, quantidade, unidade, permite_variacao")
    .eq("combo_produto_id", comboProdutoId)
    .order("ordem");
  if (error) {
    console.warn("comboCarregarComponentesParaEdicao:", error.message);
    return;
  }
  (data || []).forEach((c) => comboAdicionarComponente(c));
}

// =========================================
// FRETE PDV — ROTA REAL (OSRM)
// =========================================

function toggleDeliveryRowPDV(tipo) {
  const row = document.getElementById("pdv-delivery-row");
  if (!row) return;
  row.style.display = tipo === "delivery" ? "block" : "none";
  if (tipo !== "delivery") {
    const freteInput = document.getElementById("balcao-frete");
    const msg = document.getElementById("frete-msg-pdv");
    if (freteInput) freteInput.value = "";
    if (msg) msg.innerHTML = "";
  }
  atualizarCarrinhoPDV();
}

// Toggle switch de Delivery no PDV (chamado pelo HTML via onclick)
// ── Toggle dados do cliente no PDV ─────────────────────────────────────
function pdvToggleDados() {
  const painel = document.querySelector('.pdv-dir-dados');
  const icon   = document.getElementById('pdv-toggle-dados-icon');
  if (!painel) return;
  const aberto = painel.classList.toggle('pdv-dados-aberto');
  if (icon) {
    icon.className = aberto
      ? 'fas fa-chevron-up'
      : 'fas fa-chevron-down';
  }
}

function pdvToggleDelivery(el) {
  const isDelivery = !el.classList.contains("active");
  el.classList.toggle("active", isDelivery);
  const inp = document.getElementById("balcao-tipo-entrega");
  if (inp) inp.value = isDelivery ? "delivery" : "balcao";
  const chip = document.getElementById("pdv-tipo-chip");
  if (chip) chip.textContent = isDelivery ? "🛵 Delivery" : "🏪 Balcão";
  // Ao ativar delivery, garante que o painel de dados do cliente esteja visível
  if (isDelivery) {
    const painel = document.querySelector('.pdv-dir-dados');
    const icon   = document.getElementById('pdv-toggle-dados-icon');
    if (painel && !painel.classList.contains('pdv-dados-aberto')) {
      painel.classList.add('pdv-dados-aberto');
      if (icon) icon.className = 'fas fa-chevron-up';
    }
  }
  toggleDeliveryRowPDV(isDelivery ? "delivery" : "balcao");
}

// Consulta distância pela rota real (OSRM público). Retorna km ou null se falhar.
async function obterDistanciaPelaRota(latDestino, lngDestino) {
  const origem = `${COORD_LOJA.lng},${COORD_LOJA.lat}`;
  const destino = `${lngDestino},${latDestino}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${origem};${destino}?overview=false`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (d.code === "Ok") return d.routes[0].distance / 1000;
    return null;
  } catch {
    return null;
  }
}

async function calcularFretePDV() {
  const btn = document.getElementById("btn-gps-pdv");
  const msg = document.getElementById("frete-msg-pdv");
  const freteInput = document.getElementById("balcao-frete");

  btn.disabled = true;
  btn.innerText = "⏳";
  msg.innerHTML = '<span style="color:#888">Localizando...</span>';

  // ── Tenta extrair coordenadas do link colado no campo endereço ────────
  const endVal = (
    document.getElementById("balcao-endereco")?.value || ""
  ).trim();
  let lat = null,
    lng = null;

  if (endVal) {
    // Formatos comuns do Google Maps:
    // https://maps.google.com/?q=-25.2867,-57.6471
    // https://www.google.com/maps/@-25.2867,-57.6471,17z
    // https://goo.gl/maps/... (encurtado — não parseable sem request)
    // https://maps.app.goo.gl/... (novo encurtado)
    // https://www.google.com/maps/place/.../@-25.2867,-57.6471,...
    const patterns = [
      /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /\/place\/[^/@]*\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /maps\?.*ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
    ];
    for (const rx of patterns) {
      const m = endVal.match(rx);
      if (m) {
        lat = parseFloat(m[1]);
        lng = parseFloat(m[2]);
        break;
      }
    }
  }

  // ── Se não extraiu do link, usa GPS do dispositivo ────────────────────
  if (lat === null || lng === null) {
    if (!navigator.geolocation) {
      msg.innerHTML =
        '<span style="color:#e74c3c">Cole um link do Google Maps ou use um celular com GPS</span>';
      btn.disabled = false;
      btn.innerText = "📍 Rota";
      return;
    }
    let position;
    try {
      position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        }),
      );
    } catch {
      msg.innerHTML =
        '<span style="color:#e74c3c">Cole um link do Google Maps no campo endereço, ou permita o GPS</span>';
      btn.disabled = false;
      btn.innerText = "📍 Rota";
      return;
    }
    lat = position.coords.latitude;
    lng = position.coords.longitude;
  }

  // ── Salva coords no campo oculto para usar no insert ─────────────────
  document.getElementById("balcao-geo-lat").value = lat;
  document.getElementById("balcao-geo-lng").value = lng;

  msg.innerHTML = '<span style="color:#888">⏳ Calculando rota...</span>';
  let dist = await obterDistanciaPelaRota(lat, lng);
  let usouRota = true;
  if (dist === null) {
    // Fallback linha reta
    const R = 6371,
      toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat - COORD_LOJA.lat);
    const dLon = toRad(lng - COORD_LOJA.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(COORD_LOJA.lat)) *
        Math.cos(toRad(lat)) *
        Math.sin(dLon / 2) ** 2;
    dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    usouRota = false;
  }

  // LIMITES_KM deve ser idêntico ao index.ts (Edge Function) para evitar
  // divergência entre o frete calculado no front e o validado no servidor.
  const LIMITES_KM = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  ];
  let freteIndex = -1;
  for (let i = 0; i < LIMITES_KM.length; i++) {
    if (dist <= LIMITES_KM[i]) {
      freteIndex = i;
      break;
    }
  }

  const nota = usouRota ? "🛣️ rota" : "📏 linha reta*";

  if (
    freteIndex === -1 ||
    (TABELA_FRETE_ADMIN && TABELA_FRETE_ADMIN[freteIndex]?.acombinar)
  ) {
    msg.innerHTML = `<span style="color:#e67e22">⚠️ ${dist.toFixed(1)}km (${nota}) — combinar frete</span>`;
    freteInput.value = "";
    btn.disabled = false;
    btn.innerText = "📍 Rota";
    atualizarCarrinhoPDV();
    return;
  }

  let frete = 0;
  if (TABELA_FRETE_ADMIN?.[freteIndex]) {
    frete = TABELA_FRETE_ADMIN[freteIndex].loja || 0;
  } else {
    if (dist <= 3.3) frete = 6000;
    else if (dist <= 4.2) frete = 12000;
    else if (dist <= 5.2) frete = 18000;
    else if (dist <= 6.2) frete = 24000;
    else frete = 24000 + Math.ceil(dist - 6.2) * 3000;
  }

  freteInput.value = frete;
  const aviso = usouRota ? "" : ' <em style="color:#e67e22">(estimativa)</em>';
  msg.innerHTML = `<span style="color:#27ae60">✅ ${dist.toFixed(1)}km ${nota} → Gs ${frete.toLocaleString("es-PY")}</span>${aviso}`;
  btn.disabled = false;
  btn.innerText = "📍 Rota";
  atualizarCarrinhoPDV();
}

// ═══════════════════════════════════════════════════════════════
// ONBOARDING — Configuração inicial do restaurante
// ═══════════════════════════════════════════════════════════════

const _OB_STEPS = [
  {
    id: "identidade",
    titulo: "🏪 Identidade da Loja",
    descricao: "Como seu restaurante vai aparecer para os clientes.",
    campos: [
      {
        id: "ob-nome",
        label: "Nome do restaurante *",
        tipo: "text",
        placeholder: "Ex: Açaí do João",
        db: "nome_restaurante",
      },
      {
        id: "ob-descricao",
        label: "Descrição curta",
        tipo: "text",
        placeholder: "Ex: O melhor açaí da cidade",
        db: "descricao_loja",
      },
      {
        id: "ob-whatsapp",
        label: "WhatsApp (com DDI)",
        tipo: "text",
        placeholder: "Ex: 595981234567",
        db: "whatsapp_loja",
      },
      {
        id: "ob-logo",
        label: "URL do Logo",
        tipo: "url",
        placeholder: "https://...",
        db: "logo_url",
      },
    ],
  },
  {
    id: "visual",
    titulo: "🎨 Identidade Visual",
    descricao: "Cor principal que aparece no app do cliente.",
    campos: [
      {
        id: "ob-cor",
        label: "Cor primária",
        tipo: "color",
        placeholder: "#1a7a2e",
        db: "cor_primaria",
        extra: `<input type="text" id="ob-cor-hex" maxlength="7" placeholder="#1a7a2e"
                  style="padding:8px 12px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.9rem;width:120px;margin-left:8px"
                  oninput="var v=this.value;if(v.startsWith('#')&&v.length===7){document.getElementById('ob-cor').value=v;document.documentElement.style.setProperty('--primary',v);}">
                <span style="font-size:0.8rem;color:#888;margin-left:8px">← ou digita o hex</span>`,
      },
    ],
  },
  {
    id: "localizacao",
    titulo: "📍 Localização da Loja",
    descricao: "Coordenadas usadas para calcular o frete de entrega.",
    campos: [
      {
        id: "ob-lat",
        label: "Latitude *",
        tipo: "text",
        placeholder: "Ex: -25.2866",
        db: "coord_lat",
      },
      {
        id: "ob-lng",
        label: "Longitude *",
        tipo: "text",
        placeholder: "Ex: -57.6470",
        db: "coord_lng",
      },
    ],
    dica: `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:12px;margin-top:12px;font-size:0.83rem">
      💡 <strong>Como pegar as coordenadas:</strong><br>
      Abra <a href="https://maps.google.com" target="_blank" style="color:#2980b9">Google Maps</a>,
      clique com o botão direito no seu endereço e copie os números que aparecem (Ex: -25.286, -57.647).
    </div>`,
  },
  {
    id: "pagamento",
    titulo: "💳 Formas de Pagamento",
    descricao: "Configure PIX e Alias/Transferência para receber pagamentos.",
    campos: [
      {
        id: "ob-pix",
        label: "Chave PIX",
        tipo: "text",
        placeholder: "CPF, CNPJ, e-mail ou telefone",
        db: "chave_pix",
      },
      {
        id: "ob-nome-pix",
        label: "Nome no PIX",
        tipo: "text",
        placeholder: "Nome que aparece no QR Code",
        db: "nome_pix",
      },
      {
        id: "ob-alias",
        label: "Alias / Cuenta",
        tipo: "text",
        placeholder: "banco@alias.com.py",
        db: "dados_alias",
      },
      {
        id: "ob-cotacao",
        label: "Cotação do Real (Gs)",
        tipo: "number",
        placeholder: "1100",
        db: "cotacao_real",
      },
    ],
  },
  {
    id: "horario",
    titulo: "🕐 Horário de Funcionamento",
    descricao:
      "Configure o horário padrão. Pode afinar por dia depois em Configurações.",
    campos: [],
    custom: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Abre às</label>
          <input type="time" id="ob-hora-abre" value="10:00"
            style="width:100%;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:1rem">
        </div>
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Fecha às</label>
          <input type="time" id="ob-hora-fecha" value="23:00"
            style="width:100%;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:1rem">
        </div>
      </div>
      <p style="font-size:0.78rem;color:#999;margin-top:8px">Este horário será aplicado a todos os dias da semana.</p>
    `,
  },
];

let _obStep = 0;
let _obData = {};

async function iniciarOnboarding() {
  // Só mostra se o banco não tiver nome configurado ainda
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("nome_restaurante")
      .maybeSingle();
    if (data?.nome_restaurante) return; // já configurado
  } catch (_) {
    return;
  }

  _obStep = 0;
  _obData = {};
  _obRender();
  document.getElementById("modal-onboarding").style.display = "flex";
}

function _obRender() {
  const step = _OB_STEPS[_obStep];
  const total = _OB_STEPS.length;
  const isLast = _obStep === total - 1;
  const isFirst = _obStep === 0;

  // Dots
  const dots = document.getElementById("ob-dots");
  if (dots) {
    dots.innerHTML = _OB_STEPS
      .map(
        (s, i) => `
      <div style="height:6px;flex:1;border-radius:3px;background:${i <= _obStep ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.25)"}"></div>
    `,
      )
      .join("");
  }

  // Step label
  const lbl = document.getElementById("ob-step-label");
  if (lbl) lbl.textContent = `Passo ${_obStep + 1} de ${total}`;

  // Prev/Next buttons
  const prev = document.getElementById("ob-btn-prev");
  const next = document.getElementById("ob-btn-next");
  if (prev) prev.style.visibility = isFirst ? "hidden" : "visible";
  if (next) next.textContent = isLast ? "✅ Salvar & Concluir" : "Próximo →";

  // Body
  const body = document.getElementById("ob-body");
  if (!body) return;

  let html = `
    <h3 style="font-size:1.15rem;font-weight:800;color:#1a1a1a;margin-bottom:4px">${step.titulo}</h3>
    <p style="font-size:0.85rem;color:#666;margin-bottom:18px">${step.descricao}</p>
  `;

  // Campos padrão
  (step.campos || []).forEach((c) => {
    const savedVal = _obData[c.db] || "";
    if (c.tipo === "color") {
      html += `
        <div style="margin-bottom:14px">
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:6px">${c.label}</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="color" id="${c.id}" value="${savedVal || "#1a7a2e"}"
              style="width:52px;height:38px;border:none;border-radius:8px;cursor:pointer;padding:2px"
              oninput="document.getElementById('ob-cor-hex').value=this.value;document.documentElement.style.setProperty('--primary',this.value)">
            ${c.extra || ""}
          </div>
        </div>`;
    } else {
      html += `
        <div style="margin-bottom:14px">
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:6px">${c.label}</label>
          <input type="${c.tipo}" id="${c.id}" value="${savedVal}"
            placeholder="${c.placeholder}"
            style="width:100%;padding:10px 12px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.92rem;transition:border-color .2s"
            onfocus="this.style.borderColor='var(--primary,#1a7a2e)'" onblur="this.style.borderColor='#e0e0e0'">
        </div>`;
    }
  });

  // Custom HTML (horário)
  if (step.custom) html += step.custom;

  // Dica
  if (step.dica) html += step.dica;

  body.innerHTML = html;

  // Restaura valor cor hex se voltou ao passo
  if (step.id === "visual") {
    const corVal = _obData["cor_primaria"] || "#1a7a2e";
    const hexEl = document.getElementById("ob-cor-hex");
    if (hexEl) hexEl.value = corVal;
    document.documentElement.style.setProperty("--primary", corVal);
  }
}

function _obColetar() {
  const step = _OB_STEPS[_obStep];

  (step.campos || []).forEach((c) => {
    const el = document.getElementById(c.id);
    if (el) _obData[c.db] = el.value.trim();
  });

  // Horário: monta grade semanal simples
  if (step.id === "horario") {
    const abre = document.getElementById("ob-hora-abre")?.value || "10:00";
    const fecha = document.getElementById("ob-hora-fecha")?.value || "23:00";
    const dias = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];
    const grade = {};
    dias.forEach((d) => {
      grade[d] = { fechado: false, turnos: [{ abre, fecha }] };
    });
    _obData["horarios_semanais"] = grade;
    _obData["loja_aberta"] = true;
  }
}

function _obNext() {
  _obColetar();
  if (_obStep < _OB_STEPS.length - 1) {
    _obStep++;
    _obRender();
  } else {
    _obSalvar();
  }
}

function _obPrev() {
  _obColetar();
  if (_obStep > 0) {
    _obStep--;
    _obRender();
  }
}

function _obSkip() {
  if (
    !confirm(
      "Pular a configuração inicial? Você pode configurar depois em Configurações.",
    )
  )
    return;
  document.getElementById("modal-onboarding").style.display = "none";
}

async function _obSalvar() {
  const btn = document.getElementById("ob-btn-next");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Salvando...";
  }

  try {
    // Prepara dados — filtra vazios
    const payload = {};
    Object.entries(_obData).forEach(([k, v]) => {
      if (v !== "" && v !== null && v !== undefined) payload[k] = v;
    });

    // Numérico
    if (payload.cotacao_real)
      payload.cotacao_real = parseFloat(payload.cotacao_real) || 1100;
    if (payload.coord_lat)
      payload.coord_lat = parseFloat(payload.coord_lat) || 0;
    if (payload.coord_lng)
      payload.coord_lng = parseFloat(payload.coord_lng) || 0;

    // Sincroniza logo_url e icone_url
    if (payload.logo_url) payload.icone_url = payload.logo_url;

    const { error } = await supa
      .from("configuracoes")
      .update(payload)
      .gt("id", 0);

    if (error) throw new Error(error.message);

    // Aplica cor imediatamente
    if (payload.cor_primaria)
      document.documentElement.style.setProperty(
        "--primary",
        payload.cor_primaria,
      );

    document.getElementById("modal-onboarding").style.display = "none";

    // Toast de sucesso
    _pdvToast?.("✅ Configuração salva! O app já reflete os dados.") ||
      alert("✅ Configuração inicial salva com sucesso!");

    // Recarrega a aba de configurações se estiver aberta
    if (
      document.getElementById("configuracoes")?.classList.contains("active")
    ) {
      carregarConfiguracoes();
    }

    // Atualiza brand
    if (payload.nome_restaurante) {
      const b = document.getElementById("brand-text");
      if (b) b.textContent = payload.nome_restaurante.toUpperCase() + " ADMIN";
      NOME_RESTAURANTE = payload.nome_restaurante;
    }
  } catch (e) {
    alert("Erro ao salvar: " + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✅ Salvar & Concluir";
    }
  }
}

// Chamado no DOMContentLoaded após auth — só mostra se banco não configurado
// (injeta no fluxo de inicialização existente)
document.addEventListener("DOMContentLoaded", () => {
  // Aguarda auth (1.5s) para não conflitar com o auth-overlay
  setTimeout(async () => {
    if (perfilUsuario && ["dono", "adminMaster"].includes(perfilUsuario)) {
      await iniciarOnboarding();
    }
  }, 1500);
});

function ftMostrarPanel(panel) {
  ["insumos", "fichas"].forEach((p) => {
    const el = document.getElementById(`ft-panel-${p}`);
    const btn = document.getElementById(`ft-nav-${p}`);
    if (el) el.style.display = p === panel ? "block" : "none";
    if (btn) {
      // ft-tab-ativo = fundo preenchido; sem ela = outline com texto/borda coloridos
      btn.classList.toggle("ft-tab-ativo", p === panel);
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  PATCH 7 — Editar/Excluir Despesas (porta da aplicação-modelo)
//  Se estas funções NÃO existirem no seu admin.js atual, adicione-as:
// ─────────────────────────────────────────────────────────────
function abrirEditarDespesa(dadosEncoded) {
  try {
    const d = JSON.parse(decodeURIComponent(dadosEncoded));
    document.getElementById("edit-despesa-id").value = d.id;
    document.getElementById("edit-despesa-valor").value = d.valor;
    document.getElementById("edit-despesa-desc").value = d.descricao;
    const tipoSel = document.getElementById("edit-despesa-tipo");
    if (tipoSel) tipoSel.value = d.tipo_despesa || "despesas_gerais";
    const outroBox = document.getElementById("edit-box-outro");
    const outroInput = document.getElementById("edit-despesa-outro");
    if (d.tipo_despesa === "outro") {
      if (outroBox) outroBox.style.display = "block";
      if (outroInput) outroInput.value = d.descricao_outro || "";
    } else {
      if (outroBox) outroBox.style.display = "none";
      if (outroInput) outroInput.value = "";
    }
    document.getElementById("modal-editar-despesa").style.display = "flex";
  } catch (e) {
    alert("Erro ao abrir edição: " + e.message);
  }
}

async function salvarEdicaoDespesa() {
  const id = document.getElementById("edit-despesa-id").value;
  const valor = parseFloat(document.getElementById("edit-despesa-valor").value);
  const desc = document.getElementById("edit-despesa-desc").value.trim();
  const tipo = document.getElementById("edit-despesa-tipo").value;

  if (!id || !valor || valor <= 0) {
    alert("Preencha o valor corretamente.");
    return;
  }

  let descOutro = null;
  if (tipo === "outro") {
    descOutro =
      document.getElementById("edit-despesa-outro")?.value?.trim() || "";
    if (!descOutro) {
      alert("Descreva o tipo da despesa.");
      return;
    }
  }

  const { error } = await supa
    .from("movimentacoes_caixa")
    .update({
      valor,
      descricao: desc,
      tipo_despesa: tipo,
      descricao_outro: descOutro,
    })
    .eq("id", id);

  if (error) {
    alert("Erro ao salvar: " + error.message);
    return;
  }
  fecharModal("modal-editar-despesa");
  calcularFinanceiro();
}

async function excluirDespesa(id) {
  if (!confirm("Excluir esta despesa? Esta ação não pode ser desfeita."))
    return;
  const { error } = await supa
    .from("movimentacoes_caixa")
    .delete()
    .eq("id", id);
  if (error) {
    alert("Erro ao excluir: " + error.message);
    return;
  }
  calcularFinanceiro();
}
// ══════════════════════════════════════════════════════════════
//  VERIFICAÇÃO DE CONTRATO
//  adminMaster: bypass total.
//  dono: exibe overlay bloqueante no admin.html até assinar.
//  outros cargos: bypass (não são parte do contrato).
// ══════════════════════════════════════════════════════════════
async function verificarContratoAdmin(session) {
  try {
    const { data: perfil } = await supa
      .from("perfis_acesso")
      .select("cargo")
      .eq("id", session.user.id)
      .maybeSingle();

    const cargo = perfil?.cargo || "dono";

    // adminMaster e outros cargos não precisam assinar
    if (cargo === "adminMaster") return;
    if (cargo !== "dono") return;

    // Verifica se o dono já aceitou
    const { data } = await supa
      .from("contratos_aceites")
      .select("id")
      .eq("usuario_id", session.user.id)
      .eq("aceito", true)
      .maybeSingle();

    if (!data) {
      // Ainda não assinou — exibe overlay bloqueante no próprio admin
      _admMostrarContratoOverlay(session);
    }
  } catch (e) {
    // Fail-open: se erro ao verificar, não bloqueia o admin
    console.warn("verificarContratoAdmin error:", e.message);
  }
}

function _admMostrarContratoOverlay(session) {
  const overlay = document.getElementById("contrato-admin-overlay");
  if (!overlay) {
    // Fallback se o HTML não foi atualizado
    alert("Você precisa aceitar o contrato de serviços para continuar.");
    supa.auth.signOut().then(() => {
      window.location.href = "login.html";
    });
    return;
  }

  const hoje = new Date();
  const meses = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  const el = (id) => document.getElementById(id);
  if (el("adm-ct-dia")) el("adm-ct-dia").textContent = hoje.getDate();
  if (el("adm-ct-mes")) el("adm-ct-mes").textContent = meses[hoje.getMonth()];
  if (el("adm-ct-ano")) el("adm-ct-ano").textContent = hoje.getFullYear();

  window._admContratoSession = session;
  overlay.style.display = "flex";

  setTimeout(() => {
    const scrollArea = el("adm-contrato-scroll");
    if (scrollArea) scrollArea.scrollTop = 0;
  }, 100);
}

// ──────────────────────────────────────────────────────────────
//  FUNÇÕES DO OVERLAY DE CONTRATO (admin.html)
// ──────────────────────────────────────────────────────────────
let _admContratoScrollCompleto = false;

function admOnScrollContrato() {
  const area = document.getElementById("adm-contrato-scroll");
  const bar = document.getElementById("adm-contrato-bar");
  const hint = document.getElementById("adm-scroll-hint");
  if (!area) return;

  const pct = Math.min(
    100,
    Math.round(
      (area.scrollTop / (area.scrollHeight - area.clientHeight)) * 100,
    ),
  );
  if (bar) bar.style.width = pct + "%";

  if (pct >= 90 && !_admContratoScrollCompleto) {
    _admContratoScrollCompleto = true;
    const chk = document.getElementById("adm-chk-aceite");
    if (chk) chk.disabled = false;
    if (hint) hint.style.display = "none";
  }
}

function admAtualizarNome(val) {
  const el = document.getElementById("adm-ct-nombre");
  if (el) el.textContent = val || "[Nome do Cliente]";
}

function admAtualizarDoc(val) {
  const el = document.getElementById("adm-ct-doc");
  if (el) el.textContent = val || "[Documento]";
}

function admToggleBtnAceitar() {
  const chk = document.getElementById("adm-chk-aceite");
  const btn = document.getElementById("adm-btn-aceitar");
  const nome = document.getElementById("adm-c-nome")?.value?.trim();
  const doc = document.getElementById("adm-c-doc")?.value?.trim();
  const ok = chk?.checked && nome && doc;
  if (btn) {
    btn.disabled = !ok;
    btn.style.opacity = ok ? "1" : "0.45";
    btn.style.cursor = ok ? "pointer" : "not-allowed";
  }
}

async function admAceitarContrato() {
  const session = window._admContratoSession;
  if (!session) return;

  const nome = document.getElementById("adm-c-nome")?.value?.trim();
  const doc = document.getElementById("adm-c-doc")?.value?.trim();

  if (!nome || !doc) {
    alert("Preencha seu nome completo e RUC/C.I. para assinar.");
    return;
  }

  const btn = document.getElementById("adm-btn-aceitar");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Registrando assinatura...";
  }

  try {
    let ip = "";
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      ip = (await r.json()).ip || "";
    } catch (_) {}

    const { error } = await supa.from("contratos_aceites").insert([
      {
        usuario_id: session.user.id,
        aceito: true,
        nome_assinante: nome,
        doc_assinante: doc,
        ip_assinante: ip,
        user_agent: navigator.userAgent,
        aceito_em: new Date().toISOString(),
      },
    ]);

    if (error) {
      // Pode já existir — tenta update
      if (error.code === "23505" || error.message?.includes("duplicate")) {
        await supa
          .from("contratos_aceites")
          .update({
            aceito: true,
            nome_assinante: nome,
            doc_assinante: doc,
            aceito_em: new Date().toISOString(),
          })
          .eq("usuario_id", session.user.id);
      } else {
        throw error;
      }
    }

    const overlay = document.getElementById("contrato-admin-overlay");
    if (overlay) overlay.style.display = "none";
    console.log("✅ Contrato aceito com sucesso.");
  } catch (e) {
    alert("Erro ao registrar assinatura: " + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✍️ ASSINAR E CONTINUAR";
    }
  }
}
// ══════════════════════════════════════════════════════════════
//  VAREJO — Adições ao admin.js
//  Cole este bloco no final do seu admin.js existente.
//
//  PASSO DE ATIVAÇÃO:
//    No formulário de produto (modal-produto no admin.html),
//    adicione logo antes do botão "Salvar":
//
//      <!-- Seção de Variações de Estoque (Varejo) -->
//      <div id="secao-variacoes-estoque"></div>
//
//    O JS preenche e gerencia essa seção automaticamente
//    quando o tipo de produto é "variacoes" ou "padrao" em
//    modo varejo.
//
//  DEPENDÊNCIAS:
//    - supabaseClient.js (window.supa)
//    - A tabela produto_variacoes do banco (ver varejo-sql.sql)
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
//  Estado local do gerenciador de variações
// ──────────────────────────────────────────────────────────────
let _ve_variacoes = []; // variações em edição no modal
let _ve_prodId = null; // produto_id sendo editado (null = novo)
let _ve_variacoesSalvas = []; // snapshot do banco (para detectar exclusões)

// ──────────────────────────────────────────────────────────────
//  1. veIniciarSecao()
//     Renderiza o HTML da seção dentro de #secao-variacoes-estoque.
//     Chame ao abrir o modal de produto (ou ao mudar o tipo para
//     "variacoes" / "padrao").
// ──────────────────────────────────────────────────────────────
function veIniciarSecao(prodId = null) {
  _ve_prodId = prodId;

  const cont = document.getElementById("secao-variacoes-estoque");
  if (!cont) return;

  cont.innerHTML = `
    <!-- ── Cabeçalho ─────────────────────────────────────────── -->
    <div class="var-estoque-section-header" style="margin-top:20px">
      <h4>📦 Variações e Estoque</h4>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        onclick="veAdicionarLinha()"
        title="Adicionar variação"
      >
        + Adicionar Variação
      </button>
    </div>

    <!-- Ajuda contextual -->
    <p style="font-size:0.78rem;color:#888;margin-bottom:10px;line-height:1.5">
      Use para Tamanho/Cor (roupas), Voltagem (eletrônicos), Sabor (pods/suplementos).<br>
      Deixe <b>Controlar estoque</b> desmarcado para estoque ilimitado.
    </p>

    <!-- Lista de linhas de variação -->
    <div id="ve-lista"></div>

    <!-- Totalizador de estoque -->
    <div id="ve-totalizador" style="
      background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;
      padding:10px 14px;font-size:0.82rem;font-weight:600;color:#166534;
      margin-top:6px;display:none
    ">
      📊 Estoque total: <span id="ve-total-qtd">0</span> unidades
    </div>
  `;

  // Carrega variações existentes se for edição
  if (prodId) {
    veCarregarDosBanco(prodId);
  }
}

// ──────────────────────────────────────────────────────────────
//  2. veCarregarDosBanco(prodId)
//     Busca variações existentes e preenche a lista.
// ──────────────────────────────────────────────────────────────
async function veCarregarDosBanco(prodId) {
  const { data, error } = await supa
    .from("produto_variacoes")
    .select("*")
    .eq("produto_id", prodId)
    .order("ordem")
    .order("nome");

  if (error) {
    console.warn("veCarregarDosBanco:", error.message);
    return;
  }

  _ve_variacoes = data || [];
  _ve_variacoesSalvas = JSON.parse(JSON.stringify(_ve_variacoes));

  _veRenderizarLista();
}

// ──────────────────────────────────────────────────────────────
//  3. veAdicionarLinha(dados)
//     Adiciona uma linha de variação ao estado local e re-renderiza.
// ──────────────────────────────────────────────────────────────
function veAdicionarLinha(dados = {}) {
  _ve_variacoes.push({
    _tempId: Date.now() + Math.random(), // ID temporário (antes de salvar)
    id: dados.id || null,
    nome: dados.nome || "",
    sku: dados.sku || "",
    estoque_qtd: dados.estoque_qtd ?? 0,
    controlar_estoque: dados.controlar_estoque !== false, // default: controla
    preco_adicional: dados.preco_adicional ?? 0,
    preco_absoluto: dados.preco_absoluto || false,
    ativo: dados.ativo !== false,
  });
  _veRenderizarLista();
}

// ──────────────────────────────────────────────────────────────
//  4. _veRenderizarLista()
//     Rebuilda o HTML de todas as linhas de variação.
// ──────────────────────────────────────────────────────────────
function _veRenderizarLista() {
  const lista = document.getElementById("ve-lista");
  if (!lista) return;

  if (!_ve_variacoes.length) {
    lista.innerHTML =
      '<p style="color:#aaa;font-size:0.82rem;text-align:center;padding:14px">Nenhuma variação adicionada. Clique em "+ Adicionar Variação".</p>';
    _veAtualizarTotalizador();
    return;
  }

  lista.innerHTML = "";
  _ve_variacoes.forEach((v, idx) => {
    lista.appendChild(_veCriarLinhaDOM(v, idx));
  });

  _veAtualizarTotalizador();
}

// ──────────────────────────────────────────────────────────────
//  5. _veCriarLinhaDOM(v, idx)
//     Cria o elemento DOM de uma linha de variação.
// ──────────────────────────────────────────────────────────────
function _veCriarLinhaDOM(v, idx) {
  const esgotado = v.controlar_estoque && v.estoque_qtd <= 0;
  const row = document.createElement("div");
  row.className = "var-estoque-row" + (esgotado ? " sem-estoque-admin" : "");
  row.dataset.idx = idx;

  row.innerHTML = `
    <!-- Coluna 1: Nome + SKU + Preço próprio -->
    <div class="ve-col-info">
      <input type="text" class="form-control ve-nome" value="${_esc(v.nome)}" placeholder="Ex: Azul - M, 110v, Melancia" oninput="_veAtualizar(${idx}, 'nome', this.value)" style="font-weight:600; width:100%;">
      <div class="ve-row-fields">
        <input type="text" class="form-control ve-sku" value="${_esc(v.sku || "")}" placeholder="SKU / Cód. barras (opcional)" oninput="_veAtualizar(${idx}, 'sku', this.value)" style="flex:1; min-width:100px; font-size:0.8rem; color:#555;">
        <div class="ve-preco-wrapper">
          <span class="ve-preco-label">Preço próprio (Gs)</span>
          <input type="number" class="form-control ve-preco" value="${v.preco_adicional || ''}" min="0" oninput="_veAtualizar(${idx}, 'preco_adicional', parseFloat(this.value)||0)" style="width:120px;" placeholder="deixe em branco">
        </div>
      </div>
      <label class="ve-controla-estoque">
        <input type="checkbox" ${v.controlar_estoque ? "checked" : ""} onchange="_veAtualizar(${idx}, 'controlar_estoque', this.checked); _veRenderizarLista()">
        Controlar estoque
      </label>
    </div>

    <!-- Coluna 2: Estoque (com botões + input) -->
    <div class="ve-col-estoque">
      <label class="ve-label">ESTOQUE</label>
      <div class="ve-qtd-control">
        <button type="button" onclick="_veAlterarQtd(${idx}, -1)" class="ve-qtd-btn" ${!v.controlar_estoque ? 'disabled' : ''}>−</button>
        <input type="number" class="form-control ve-qtd" value="${v.estoque_qtd}" min="0" oninput="_veAtualizar(${idx}, 'estoque_qtd', parseInt(this.value)||0); _veAtualizarTotalizador()" ${!v.controlar_estoque ? 'disabled placeholder="∞"' : ''}>
        <button type="button" onclick="_veAlterarQtd(${idx}, 1)" class="ve-qtd-btn" ${!v.controlar_estoque ? 'disabled' : ''}>+</button>
      </div>
      ${esgotado ? '<span class="ve-badge-esgotado">Esgotado</span>' : ''}
      ${!v.controlar_estoque ? '<span class="ve-ilimitado">∞ ilimitado</span>' : ''}
    </div>

    <!-- Coluna 3: Status (toggle) -->
    <div class="ve-col-status">
      <label class="ve-label">STATUS</label>
      <label class="toggle-switch" title="${v.ativo ? "Disponível" : "Pausado"}">
        <input type="checkbox" ${v.ativo ? "checked" : ""} onchange="_veAtualizar(${idx}, 'ativo', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span class="ve-status-text" style="color:${v.ativo ? "#16a34a" : "#dc2626"}">${v.ativo ? "Disponível" : "Pausado"}</span>
    </div>

    <!-- Coluna 4: Remover -->
    <div class="ve-col-remove">
      <button type="button" class="btn-remove-variacao" onclick="veRemoverLinha(${idx})" title="Remover variação">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;

  return row;
}

// Utilitário de escape HTML
function _esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ──────────────────────────────────────────────────────────────
//  6. Helpers de atualização de estado
// ──────────────────────────────────────────────────────────────
function _veAtualizar(idx, campo, valor) {
  if (!_ve_variacoes[idx]) return;
  _ve_variacoes[idx][campo] = valor;
  _veAtualizarTotalizador();
}

function _veAlterarQtd(idx, delta) {
  if (!_ve_variacoes[idx] || !_ve_variacoes[idx].controlar_estoque) return;
  const novaQtd = Math.max(0, (_ve_variacoes[idx].estoque_qtd || 0) + delta);
  _ve_variacoes[idx].estoque_qtd = novaQtd;
  _veRenderizarLista();
}

function veRemoverLinha(idx) {
  _ve_variacoes.splice(idx, 1);
  _veRenderizarLista();
}

function _veAtualizarTotalizador() {
  const el = document.getElementById("ve-totalizador");
  const qtdEl = document.getElementById("ve-total-qtd");
  if (!el || !qtdEl) return;

  const total = _ve_variacoes.reduce((s, v) => {
    return s + (v.controlar_estoque ? v.estoque_qtd || 0 : 0);
  }, 0);

  if (_ve_variacoes.length > 0) {
    el.style.display = "block";
    qtdEl.textContent = total.toLocaleString("es-PY");
  } else {
    el.style.display = "none";
  }
}

// ──────────────────────────────────────────────────────────────
//  7. veSalvarVariacoes(prodId)
//     Persiste as variações no banco (upsert + delete de removidas).
//     Chame isso dentro da sua função salvarProduto() APÓS salvar
//     o produto principal, usando o prodId retornado.
//
//  Uso:
//    const prodIdSalvo = ...; // id retornado pelo INSERT/UPDATE
//    const ok = await veSalvarVariacoes(prodIdSalvo);
//    if (!ok) { alert('Erro ao salvar variações'); return; }
// ──────────────────────────────────────────────────────────────
async function veSalvarVariacoes(prodId) {
  try {
    // Sincroniza estado dos inputs com _ve_variacoes
    _veLerDOMParaEstado();

    // IDs que existiam antes (para detectar exclusões)
    const idsSalvos = _ve_variacoesSalvas.filter((v) => v.id).map((v) => v.id);
    const idsAtuais = _ve_variacoes.filter((v) => v.id).map((v) => v.id);
    const idsRemovidos = idsSalvos.filter((id) => !idsAtuais.includes(id));

    // Exclui variações removidas
    if (idsRemovidos.length > 0) {
      const { error } = await supa
        .from("produto_variacoes")
        .delete()
        .in("id", idsRemovidos);
      if (error) throw new Error("Erro ao excluir variações: " + error.message);
    }

    // Upsert das variações restantes
    if (_ve_variacoes.length > 0) {
      const payload = _ve_variacoes
        .filter((v) => v.nome && v.nome.trim()) // ignora linhas sem nome
        .map((v, i) => {
          const obj = {
            produto_id: prodId,
            nome: v.nome.trim(),
            sku: v.sku?.trim() || null,
            estoque_qtd: v.controlar_estoque
              ? Math.max(0, parseInt(v.estoque_qtd) || 0)
              : 0,
            controlar_estoque: !!v.controlar_estoque,
            preco_adicional: parseFloat(v.preco_adicional) || 0,
            ativo: v.ativo !== false,
            ordem: i,
          };
          // ⚠️ SÓ inclui o campo 'id' se ele existir e for um número > 0
          if (v.id && Number(v.id) > 0) {
            obj.id = Number(v.id);
          }
          return obj;
        });

      if (payload.length > 0) {
        // Usa upsert com conflito em 'id' (se houver)
        const { error } = await supa
          .from("produto_variacoes")
          .upsert(payload, { onConflict: "id" });
        if (error)
          throw new Error("Erro ao salvar variações: " + error.message);
      }
    }

    console.log(
      "[varejo-admin] Variações salvas com sucesso para produto",
      prodId,
    );
    return true;
  } catch (e) {
    console.error("[varejo-admin] veSalvarVariacoes:", e.message);
    alert("❌ " + e.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
//  8. _veLerDOMParaEstado()
//     Antes de salvar, lê todos os inputs do DOM de volta para
//     _ve_variacoes (garante valores mais recentes sem depender
//     só dos oninput).
// ──────────────────────────────────────────────────────────────
function _veLerDOMParaEstado() {
  const rows = document.querySelectorAll("#ve-lista .var-estoque-row");
  rows.forEach((row, idx) => {
    if (!_ve_variacoes[idx]) return;
    const nomeEl = row.querySelector(".ve-nome");
    const qtdEl = row.querySelector(".ve-qtd");
    if (nomeEl) _ve_variacoes[idx].nome = nomeEl.value.trim();
    if (qtdEl) _ve_variacoes[idx].estoque_qtd = parseInt(qtdEl.value) || 0;
  });
}

// ──────────────────────────────────────────────────────────────
//  9. Painel de estoque baixo (alertas no admin)
// ── ALERTA DE VALIDADE PRÓXIMA — Produtos ─────────────────────
//     Varre _todosProdutos após carregamento e exibe banner na
//     aba Produtos para itens vencidos ou vencendo em ≤ diasAlerta.
// ──────────────────────────────────────────────────────────────
function ptVerificarValidadeProdutos(diasAlerta = 7) {
  const el = document.getElementById("pt-alerta-validade");
  const li = document.getElementById("pt-alerta-validade-lista");
  if (!el || !li) return;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const alertas = [];
  (_todosProdutos || []).forEach((p) => {
    if (!p.perecivel || !p.data_validade) return;
    // Não alertar se produto está sem estoque (zerado ou pausado)
    if (p.ativo === false) return;
    if (p.estoque_qtd !== null && p.estoque_qtd !== undefined && p.estoque_qtd <= 0) return;
    const val = new Date(p.data_validade + "T00:00:00");
    const dias = Math.ceil((val - hoje) / 86400000);
    if (dias <= diasAlerta) {
      const label =
        dias < 0
          ? `${p.nome} (VENCIDO)`
          : dias === 0
            ? `${p.nome} (vence HOJE)`
            : `${p.nome} (vence em ${dias}d)`;
      alertas.push(label);
    }
  });
  if (alertas.length) {
    el.style.display = "block";
    li.textContent = alertas.join(" • ");
  } else {
    el.style.display = "none";
  }
}

//     Exibe badge de alerta na aba de Produtos quando há variações
//     com estoque crítico (≤ limiteAlerta).
// ──────────────────────────────────────────────────────────────
async function veVerificarEstoqueBaixo(limiteAlerta = 5) {
  const { data, error } = await supa
    .from("produto_variacoes")
    .select(
      "id, produto_id, nome, estoque_qtd, controlar_estoque, produtos(nome)",
    )
    .eq("ativo", true)
    .eq("controlar_estoque", true)
    .lte("estoque_qtd", limiteAlerta)
    .order("estoque_qtd");

  if (error || !data) return;

  // Filtrar: não exibir se estoque = 0 (esgotado — produto pausado automaticamente)
  const alertaveis = data.filter((v) => v.estoque_qtd > 0);

  const cont = document.getElementById("ve-alertas-estoque");
  if (!cont) return;

  if (!alertaveis.length) {
    cont.style.display = "none";
    return;
  }

  cont.style.display = "block";
  cont.innerHTML = `
    <div style="background:#fff3cd;border:1.5px solid #f0a500;border-radius:10px;padding:12px 16px;font-size:0.83rem">
      <b>⚠️ Estoque baixo (≤ ${limiteAlerta} unidades)</b>
      <ul style="margin-top:8px;padding-left:18px;line-height:1.9">
        ${alertaveis
          .map(
            (v) => `
          <li>
            <b>${v.produtos?.nome || "#" + v.produto_id}</b> — ${v.nome}:
            <span style="color:#e67e22;font-weight:700">
              ${v.estoque_qtd} un
            </span>
          </li>
        `,
          )
          .join("")}
      </ul>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────
//  10. INTEGRAÇÃO COM salvarProduto() EXISTENTE
//
//  Localize a sua função salvarProduto() em admin.js e, após
//  a linha que salva no banco:
//
//    if (id) await supa.from('produtos').update(dados).eq('id', id);
//    else    await supa.from('produtos').insert([dados]);
//
//  Adicione estas linhas (copie e cole):
//
//    // ── Salva variações de estoque (varejo) ──────────────────
//    const _prodIdSalvo = id
//      ? parseInt(id)
//      : (await supa.from('produtos').select('id').order('id', {ascending:false}).limit(1).single()).data?.id;
//    if (_prodIdSalvo && document.getElementById('secao-variacoes-estoque')) {
//      await veSalvarVariacoes(_prodIdSalvo);
//    }
//    // ── Fim variações ────────────────────────────────────────
//
//  E na função abrirModalProduto(), ao abrir com produto existente,
//  adicione:
//
//    veIniciarSecao(produto?.id || null);
//
//  E ao abrir para novo produto:
//
//    veIniciarSecao(null);
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
//  11. Painel de Estoque — aba standalone no admin
//      Renderiza tabela completa de variações com edição rápida
//      de quantidade. Adicione no admin.html uma aba com id="estoque"
//      e um div id="painel-estoque" dentro dela.
// ──────────────────────────────────────────────────────────────
async function veRenderizarPainelEstoque() {
  const cont = document.getElementById("painel-estoque");
  if (!cont) return;

  cont.innerHTML =
    '<div style="text-align:center;padding:30px;color:#aaa">Carregando...</div>';

  const { data, error } = await supa
    .from("produto_variacoes")
    .select(
      "id, produto_id, nome, sku, estoque_qtd, controlar_estoque, ativo, produtos(nome, categoria_slug, imagem_url)",
    )
    .order("produtos(nome)")
    .order("nome");

  if (error) {
    cont.innerHTML = `<p style="color:#e74c3c">Erro: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    cont.innerHTML =
      '<p style="color:#aaa;text-align:center;padding:30px">Nenhuma variação cadastrada. Edite um produto para adicionar variações.</p>';
    return;
  }

  // Agrupa por produto
  const porProduto = {};
  data.forEach((v) => {
    const pid = v.produto_id;
    if (!porProduto[pid]) {
      porProduto[pid] = {
        nome: v.produtos?.nome || `#${pid}`,
        cat: v.produtos?.categoria_slug || "",
        img: v.produtos?.imagem_url || "",
        variacoes: [],
      };
    }
    porProduto[pid].variacoes.push(v);
  });

  // Filtragem rápida por nome
  const searchId = "ve-painel-busca-" + Date.now();
  cont.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <input id="${searchId}" type="text" class="form-control"
        placeholder="🔍 Buscar produto ou variação..."
        oninput="veFiltrarPainel(this.value)"
        style="max-width:320px">
      <button class="btn btn-sm btn-success" onclick="veRenderizarPainelEstoque()">↺ Atualizar</button>
    </div>
    <div id="ve-painel-lista"></div>
  `;

  window._vePainelDados = porProduto; // guarda para filtro
  _veRenderizarTabelaPainel(porProduto);
}

function veFiltrarPainel(termo) {
  if (!window._vePainelDados) return;
  const t = termo.toLowerCase().trim();
  if (!t) {
    _veRenderizarTabelaPainel(window._vePainelDados);
    return;
  }
  const filtrado = {};
  Object.entries(window._vePainelDados).forEach(([pid, p]) => {
    const varFiltradas = p.variacoes.filter(
      (v) =>
        v.nome.toLowerCase().includes(t) ||
        (v.sku || "").toLowerCase().includes(t),
    );
    const nomeMatch = p.nome.toLowerCase().includes(t);
    if (nomeMatch || varFiltradas.length > 0) {
      filtrado[pid] = {
        ...p,
        variacoes: nomeMatch ? p.variacoes : varFiltradas,
      };
    }
  });
  _veRenderizarTabelaPainel(filtrado);
}

function _veRenderizarTabelaPainel(porProduto) {
  const lista = document.getElementById("ve-painel-lista");
  if (!lista) return;

  lista.innerHTML =
    Object.entries(porProduto)
      .map(([pid, p]) => {
        const linhas = p.variacoes
          .map((v) => {
            const esgotado = v.controlar_estoque && v.estoque_qtd <= 0;
            return `
        <tr style="background:${esgotado ? "#fff5f5" : "#fff"}">
          <td style="font-weight:600;padding:8px 12px">${_esc(v.nome)}</td>
          <td style="text-align:center;padding:8px 12px;color:#777;font-size:0.82rem">${_esc(v.sku || "—")}</td>
          <td style="text-align:center;padding:8px 12px">
            ${
              v.controlar_estoque
                ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px">
                  <button onclick="veQuickUpdate(${v.id}, ${v.estoque_qtd - 1})"
                    style="width:24px;height:24px;border-radius:5px;border:1px solid #ccc;background:#fff;cursor:pointer">−</button>
                  <b style="color:${esgotado ? "#dc2626" : "#166534"};min-width:28px;text-align:center">${v.estoque_qtd}</b>
                  <button onclick="veQuickUpdate(${v.id}, ${v.estoque_qtd + 1})"
                    style="width:24px;height:24px;border-radius:5px;border:1px solid #ccc;background:#fff;cursor:pointer">+</button>
                </div>`
                : '<span style="color:#888;font-size:0.8rem">∞</span>'
            }
          </td>
          <td style="text-align:center;padding:8px 12px">
            <span style="background:${v.ativo ? "#dcfce7" : "#fee2e2"};color:${v.ativo ? "#166534" : "#dc2626"};
              border-radius:20px;padding:2px 10px;font-size:0.72rem;font-weight:700">
              ${v.ativo ? "●  Ativo" : "○  Pausado"}
            </span>
          </td>
        </tr>
      `;
          })
          .join("");

        return `
      <div style="background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;margin-bottom:14px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb">
          ${p.img ? `<img src="${p.img}" style="width:36px;height:36px;border-radius:7px;object-fit:cover">` : '<div style="width:36px;height:36px;border-radius:7px;background:#eee;display:flex;align-items:center;justify-content:center;color:#ccc">📦</div>'}
          <div>
            <b style="font-size:0.95rem">${_esc(p.nome)}</b>
            ${p.cat ? `<span style="font-size:0.72rem;color:#888;margin-left:8px">${p.cat}</span>` : ""}
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f3f4f6;font-size:0.72rem;color:#777;text-transform:uppercase;letter-spacing:0.04em">
              <th style="padding:6px 12px;text-align:left">Variação</th>
              <th style="padding:6px 12px;text-align:center">SKU</th>
              <th style="padding:6px 12px;text-align:center">Estoque</th>
              <th style="padding:6px 12px;text-align:center">Status</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    `;
      })
      .join("") ||
    '<p style="color:#aaa;text-align:center;padding:20px">Nenhum resultado.</p>';
}

// ──────────────────────────────────────────────────────────────
//  12. veQuickUpdate — atualiza estoque direto do painel
// ──────────────────────────────────────────────────────────────
async function veQuickUpdate(variacaoId, novaQtd) {
  novaQtd = Math.max(0, novaQtd);
  const { error } = await supa
    .from("produto_variacoes")
    .update({ estoque_qtd: novaQtd })
    .eq("id", variacaoId);

  if (error) {
    if (typeof mostrarToast === "function")
      mostrarToast("Erro ao atualizar estoque", "error");
    return;
  }

  // Atualiza o dado em memória
  if (window._vePainelDados) {
    Object.values(window._vePainelDados).forEach((p) => {
      const v = p.variacoes.find((v) => v.id === variacaoId);
      if (v) v.estoque_qtd = novaQtd;
    });
    _veRenderizarTabelaPainel(window._vePainelDados);
  }

  if (typeof mostrarToast === "function")
    mostrarToast("Estoque atualizado!", "success", 1500);
}

// ══════════════════════════════════════════════════════════════
//  VAREJO — Sugestões de variações por tipo
// ══════════════════════════════════════════════════════════════

/**
 * Mostra chips de sugestão de variações quando a lista está vazia.
 * Clique em um chip adiciona automaticamente a variação com qtd=10.
 */
function _veMostrarSugestoes(sugestoes) {
  const lista = document.getElementById("ve-lista");
  if (!lista || _ve_variacoes.length > 0) return;

  const wrap = document.createElement("div");
  wrap.id = "ve-sugestoes-wrap";
  wrap.style.cssText = "margin-bottom:10px";
  wrap.innerHTML = `
    <p style="font-size:0.75rem;color:#888;margin-bottom:6px">
      💡 Sugestões rápidas — clique para adicionar:
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:7px">
      ${sugestoes
        .map(
          (s) => `
        <button type="button"
          onclick="_veAdicionarSugestao('${s.replace(/'/g, "\\'")}')"
          style="padding:5px 12px;border:1.5px dashed #c4b5fd;background:#faf5ff;
                 border-radius:20px;font-size:0.78rem;color:#7c3aed;cursor:pointer">
          + ${s}
        </button>
      `,
        )
        .join("")}
    </div>
  `;

  // Insere antes da lista real
  const cont = document.getElementById("secao-variacoes-estoque");
  const headerEl = cont?.querySelector(".var-estoque-section-header");
  if (headerEl) headerEl.after(wrap);
}

function _veAdicionarSugestao(nome) {
  // Remove o painel de sugestões após primeiro uso
  document.getElementById("ve-sugestoes-wrap")?.remove();
  veAdicionarLinha({ nome, estoque_qtd: 10 });
}

// ══════════════════════════════════════════════════════════════
//  MOEDA DUPLA — Admin (Configurações + preview modal)
// ══════════════════════════════════════════════════════════════

// ── Chaves no localStorage ────────────────────────────────────
const _VC_KEY_ATIVO = "vc_ativo";
const _VC_KEY_TAXA = "vc_taxa";
const _VC_KEY_POSICAO = "vc_posicao";

/**
 * Carrega config salva e preenche os campos da aba Configurações.
 * Chame dentro de showTab('configuracoes') ou no DOMContentLoaded.
 */
function vcCarregarConfig() {
  const ativo = localStorage.getItem(_VC_KEY_ATIVO) === "true";
  const taxa = parseFloat(localStorage.getItem(_VC_KEY_TAXA)) || 0;
  const posicao = localStorage.getItem(_VC_KEY_POSICAO) || "abaixo";

  const elAtivo = document.getElementById("vc-ativo");
  const elTaxa = document.getElementById("vc-taxa");
  const elPosicao = document.getElementById("vc-posicao");

  if (elAtivo) {
    elAtivo.checked = ativo;
    vcToggle(ativo, false);
  }
  if (elTaxa) {
    elTaxa.value = taxa || "";
  }
  if (elPosicao) {
    elPosicao.value = posicao;
  }

  vcAtualizarLabel();
}

/** Atualiza o label "1 R$ = X Gs" ao vivo */
function vcAtualizarLabel() {
  const taxa = parseFloat(document.getElementById("vc-taxa")?.value) || 0;
  const el = document.getElementById("vc-taxa-label");
  if (el) el.textContent = taxa > 0 ? taxa.toLocaleString("es-PY") : "?";

  // Atualiza preview
  const prevCfg = document.getElementById("vc-preview-cfg");
  const prevBrl = document.getElementById("vc-prev-brl");
  if (!prevCfg || !prevBrl) return;

  if (taxa > 0 && document.getElementById("vc-ativo")?.checked) {
    prevCfg.style.display = "block";
    const exemplGs = 150000;
    const brl = exemplGs / taxa;
    prevBrl.textContent = `= R$ ${brl.toFixed(2)}`;
  } else {
    prevCfg.style.display = "none";
  }
}

function vcToggle(on, atualizarPreview = true) {
  const label = document.getElementById("vc-ativo-label");
  if (label) {
    label.textContent = on ? "Ativado ✅" : "Desativado";
    label.style.color = on ? "#16a34a" : "#888";
  }
  if (atualizarPreview) vcAtualizarLabel();
}

/** Salva configurações no localStorage e propaga para o app do cliente */
function vcSalvar() {
  const ativo = document.getElementById("vc-ativo")?.checked || false;
  const taxa = parseFloat(document.getElementById("vc-taxa")?.value) || 0;
  const posicao = document.getElementById("vc-posicao")?.value || "abaixo";

  if (ativo && taxa <= 0) {
    alert("Informe a taxa de conversão (Ex: 1450) para ativar o preço em R$.");
    return;
  }

  localStorage.setItem(_VC_KEY_ATIVO, String(ativo));
  localStorage.setItem(_VC_KEY_TAXA, String(taxa));
  localStorage.setItem(_VC_KEY_POSICAO, posicao);

  // Persiste também no banco (tabela configuracoes, coluna vc_config)
  if (window.supa) {
    supa
      .from("configuracoes")
      .update({ vc_config: { ativo, taxa, posicao } })
      .eq("id", 1)
      .then(({ error }) => {
        if (error) console.warn("vcSalvar banco:", error.message);
      });
  }

  if (typeof mostrarToast === "function") {
    mostrarToast(
      ativo
        ? `Taxa salva: 1 R$ = Gs ${taxa.toLocaleString("es-PY")}`
        : "Exibição em R$ desativada.",
      "success",
      2500,
    );
  } else {
    alert(
      ativo
        ? `✅ Taxa salva: 1 R$ = Gs ${taxa.toLocaleString("es-PY")}`
        : "✅ Exibição em R$ desativada.",
    );
  }
}

/**
 * Preview no modal de produto — chamado pelo oninput do campo prod-preco.
 * Exibe o equivalente em R$ abaixo do campo de preço.
 */
function vcAtualizarPreviewModal(gsValor) {
  const el = document.getElementById("vc-preview-modal");
  if (!el) return;

  const ativo = localStorage.getItem(_VC_KEY_ATIVO) === "true";
  const taxa = parseFloat(localStorage.getItem(_VC_KEY_TAXA)) || 0;
  const gs = parseFloat(gsValor) || 0;

  if (!ativo || taxa <= 0 || gs <= 0) {
    el.textContent = "";
    return;
  }

  const brl = gs / taxa;
  el.textContent = `≈ R$ ${brl.toFixed(2)} (taxa: 1 R$ = Gs ${taxa.toLocaleString("es-PY")})`;
}

// Carrega config quando a aba de configurações é aberta
(function _vcPatchShowTab() {
  const _origShowTab = window.showTab;
  if (typeof _origShowTab !== "function") return;
  window.showTab = function (tabId, event) {
    _origShowTab(tabId, event);
    if ((tabId || "").includes("configuracoes")) {
      setTimeout(vcCarregarConfig, 50);
    }
  };
})();

// ══════════════════════════════════════════════════════════════
//  PROMOÇÃO — Helpers do formulário de produto
// ══════════════════════════════════════════════════════════════

function togglePromoFields(on) {
  const fields = document.getElementById("prod-promo-fields");
  if (fields) fields.style.display = on ? "grid" : "none";
  if (on) promoAtualizarPreview();
}

function promoAtualizarPreview() {
  const tipo = document.getElementById("prod-promo-tipo")?.value || "percent";
  const valor =
    parseFloat(document.getElementById("prod-promo-valor")?.value) || 0;
  const preco = parseFloat(document.getElementById("prod-preco")?.value) || 0;
  const prev = document.getElementById("prod-promo-preview");
  const label = document.getElementById("prod-promo-valor-label");

  if (label)
    label.textContent = tipo === "percent" ? "Desconto (%)" : "Desconto (Gs)";
  if (!prev) return;

  if (!valor || !preco) {
    prev.textContent = "";
    return;
  }

  const precoFinal =
    tipo === "percent" ? preco * (1 - valor / 100) : preco - valor;

  if (precoFinal < 0) {
    prev.textContent = "⚠️ Desconto maior que o preço!";
    prev.style.color = "#dc2626";
    return;
  }

  prev.style.color = "#16a34a";
  prev.innerHTML = `
    De <s style="color:#aaa">Gs ${Math.round(preco).toLocaleString("es-PY")}</s>
    por <b style="color:#dc2626">Gs ${Math.round(precoFinal).toLocaleString("es-PY")}</b>
    ${tipo === "percent" ? `(${valor}% off)` : `(- Gs ${Math.round(valor).toLocaleString("es-PY")})`}
  `;
}

// ── Atualiza _TIPO_ICONS e _TIPO_NAMES com tipos varejo ──────
// (sobrescreve as versões locais dentro de renderizarCardsProdutos)
const _VAREJO_TIPO_ICONS_PATCH = {
  roupa: "👕",
  eletronico: "🔌",
  suplemento: "💪",
  pod: "☁️",
  mercado: "🛒",
};
const _VAREJO_TIPO_NAMES_PATCH = {
  roupa: "Roupa",
  eletronico: "Eletrônico",
  suplemento: "Suplemento",
  pod: "Pod",
  mercado: "Mercado",
};
// Injeta no próximo ciclo para garantir que renderizarCardsProdutos já foi definida
setTimeout(() => {
  const origRender = window.renderizarCardsProdutos;
  if (typeof origRender !== "function") return;
  window.renderizarCardsProdutos = function (lista) {
    // Injeta ícones varejo nos mapas locais da função original
    // (feito via patch do tipoKey lookup — sem reescrever a função toda)
    origRender(lista);
  };
}, 0);

// ══════════════════════════════════════════════════════════════
//  IMPORTAÇÃO / EXPORTAÇÃO DE PRODUTOS
//  Formatos suportados: CSV, JSON, XLSX (SheetJS via CDN)
// ══════════════════════════════════════════════════════════════

// ── Colunas disponíveis ───────────────────────────────────────
const _IMPEXP_COLUNAS = [
  { key: "nome", label: "Nome", obrigatorio: true },
  { key: "descricao", label: "Descrição", obrigatorio: false },
  { key: "preco", label: "Preço (Gs)", obrigatorio: true },
  { key: "categoria_slug", label: "Categoria", obrigatorio: false },
  { key: "subcategoria_slug", label: "Subcategoria", obrigatorio: false },
  { key: "unidade_venda", label: "Unidade", obrigatorio: false },
  { key: "estoque_qtd", label: "Estoque", obrigatorio: false },
  { key: "destaque", label: "Destaque", obrigatorio: false },
  { key: "ativo", label: "Ativo", obrigatorio: false },
  { key: "somente_balcao", label: "Só Balcão", obrigatorio: false },
  { key: "promo_ativo", label: "Promoção Ativa", obrigatorio: false },
  { key: "promo_tipo", label: "Tipo Desconto", obrigatorio: false },
  { key: "promo_valor", label: "Valor Desconto", obrigatorio: false },
  { key: "imagem_url", label: "URL Imagem", obrigatorio: false },
];

// Colunas marcadas por padrão
const _IMPEXP_COLUNAS_DEFAULT = [
  "nome",
  "descricao",
  "preco",
  "categoria_slug",
  "unidade_venda",
  "estoque_qtd",
  "destaque",
  "ativo",
  "promo_ativo",
  "promo_tipo",
  "promo_valor",
];

let _impexpDadosImport = []; // linhas parseadas prontas para salvar

// ── Abrir / fechar modal ──────────────────────────────────────
function impexpAbrir() {
  const modal = document.getElementById("modal-impexp");
  if (!modal) return;
  impexpMostrarAba("exportar");
  _impexpRenderizarColunas();
  _impexpCarregarCategorias();
  modal.style.display = "flex";
}

function impexpFechar() {
  const modal = document.getElementById("modal-impexp");
  if (modal) modal.style.display = "none";
  impexpLimparPreview();
}

// ── Abas internas ─────────────────────────────────────────────
function impexpMostrarAba(aba) {
  const isExp = aba === "exportar";
  document.getElementById("impexp-painel-exportar").style.display = isExp
    ? "block"
    : "none";
  document.getElementById("impexp-painel-importar").style.display = isExp
    ? "none"
    : "block";

  const btnExp = document.getElementById("impexp-tab-exp");
  const btnImp = document.getElementById("impexp-tab-imp");
  if (btnExp) {
    btnExp.style.background = isExp ? "#1a7a2e" : "transparent";
    btnExp.style.color = isExp ? "#fff" : "#555";
  }
  if (btnImp) {
    btnImp.style.background = isExp ? "transparent" : "#1a7a2e";
    btnImp.style.color = isExp ? "#555" : "#fff";
  }
}

// ── Checkboxes de colunas ─────────────────────────────────────
function _impexpRenderizarColunas() {
  const wrap = document.getElementById("impexp-colunas-wrap");
  if (!wrap) return;
  wrap.innerHTML = _IMPEXP_COLUNAS
    .map((c) => {
      const checked = _IMPEXP_COLUNAS_DEFAULT.includes(c.key) || c.obrigatorio;
      const disabled = c.obrigatorio ? "disabled" : "";
      return `
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;
        background:#f9fafb;border:1px solid #e5e7eb;border-radius:7px;
        padding:5px 10px;font-size:0.78rem;font-weight:600;
        ${c.obrigatorio ? "opacity:0.7" : ""}">
        <input type="checkbox" class="impexp-col-chk" value="${c.key}"
          ${checked ? "checked" : ""} ${disabled}>
        ${c.label}${c.obrigatorio ? ' <span style="color:#dc2626">*</span>' : ""}
      </label>`;
    })
    .join("");
}

function impexpSelecionarTodasColunas(on) {
  document
    .querySelectorAll(".impexp-col-chk:not([disabled])")
    .forEach((c) => (c.checked = on));
}

async function _impexpCarregarCategorias() {
  const sel = document.getElementById("impexp-exp-cat");
  if (!sel || sel.options.length > 1) return;
  const { data } = await supa
    .from("categorias")
    .select("slug,nome_exibicao")
    .order("nome_exibicao");
  if (data)
    data.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.slug;
      opt.textContent = c.nome_exibicao;
      sel.appendChild(opt);
    });
}

// ─────────────────────────────────────────────────────────────
//  EXPORTAÇÃO
// ─────────────────────────────────────────────────────────────
async function impexpExportar() {
  const infoEl = document.getElementById("impexp-exp-info");
  if (infoEl) infoEl.textContent = "Buscando dados…";

  // Colunas selecionadas
  const colunas = [...document.querySelectorAll(".impexp-col-chk:checked")].map(
    (c) => c.value,
  );
  if (!colunas.length) {
    alert("Selecione ao menos uma coluna.");
    return;
  }

  // Filtros
  const catFiltro = document.getElementById("impexp-exp-cat")?.value;
  const statusFiltro = document.getElementById("impexp-exp-status")?.value;

  let query = supa.from("produtos").select(colunas.join(",")).order("nome");
  if (catFiltro) query = query.eq("categoria_slug", catFiltro);
  if (statusFiltro === "ativo")
    query = query.eq("ativo", true).eq("pausado", false);
  if (statusFiltro === "pausado") query = query.eq("pausado", true);
  if (statusFiltro === "destaque") query = query.eq("destaque", true);

  const { data, error } = await query;
  if (error) {
    alert("Erro ao exportar: " + error.message);
    return;
  }
  if (!data?.length) {
    if (infoEl)
      infoEl.textContent = "Nenhum produto encontrado com esses filtros.";
    return;
  }

  const formato =
    document.querySelector("input[name='impexp-formato']:checked")?.value ||
    "csv";
  const nomeArq = `produtos_${new Date().toISOString().slice(0, 10)}`;

  if (formato === "csv") _impexpBaixarCSV(data, colunas, nomeArq + ".csv");
  if (formato === "json") _impexpBaixarJSON(data, nomeArq + ".json");
  if (formato === "xlsx") _impexpBaixarXLSX(data, colunas, nomeArq + ".xlsx");

  if (infoEl)
    infoEl.textContent = `✅ ${data.length} produto(s) exportado(s) — ${formato.toUpperCase()}`;
}

function _impexpBaixarCSV(rows, colunas, nomeArq) {
  const escapar = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = colunas
    .map((c) => _IMPEXP_COLUNAS.find((x) => x.key === c)?.label || c)
    .join(",");
  const linhas = rows.map((r) => colunas.map((c) => escapar(r[c])).join(","));
  _impexpDownload(
    "\uFEFF" + [header, ...linhas].join("\r\n"), // BOM para Excel reconhecer UTF-8
    nomeArq,
    "text/csv;charset=utf-8;",
  );
}

function _impexpBaixarJSON(rows, nomeArq) {
  _impexpDownload(JSON.stringify(rows, null, 2), nomeArq, "application/json");
}

function _impexpBaixarXLSX(rows, colunas, nomeArq) {
  // Usa SheetJS (XLSX) — carregado dinamicamente se necessário
  const _fazer = () => {
    const XLSX = window.XLSX;
    if (!XLSX) {
      alert("Biblioteca XLSX não disponível. Tente CSV ou JSON.");
      return;
    }
    const wsData = [
      colunas.map((c) => _IMPEXP_COLUNAS.find((x) => x.key === c)?.label || c),
      ...rows.map((r) => colunas.map((c) => r[c] ?? "")),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    // Larguras automáticas
    ws["!cols"] = colunas.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Produtos");
    XLSX.writeFile(wb, nomeArq);
  };

  if (!window.XLSX) {
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = _fazer;
    document.head.appendChild(script);
  } else {
    _fazer();
  }
}

function _impexpDownload(conteudo, nomeArq, mimeType) {
  const blob = new Blob([conteudo], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArq;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ─────────────────────────────────────────────────────────────
//  TEMPLATES PARA DOWNLOAD
// ─────────────────────────────────────────────────────────────
function impexpBaixarTemplate(formato) {
  const exemplo = [
    {
      nome: "Camiseta Básica Branca",
      descricao: "100% algodão penteado",
      preco: 85000,
      categoria_slug: "roupas",
      subcategoria_slug: "",
      unidade_venda: "un",
      estoque_qtd: 50,
      destaque: false,
      ativo: true,
      somente_balcao: false,
      promo_ativo: false,
      promo_tipo: "percent",
      promo_valor: "",
      imagem_url: "",
    },
    {
      nome: "Whey Protein Chocolate 900g",
      descricao: "Proteína isolada 80%",
      preco: 320000,
      categoria_slug: "suplementos",
      subcategoria_slug: "",
      unidade_venda: "un",
      estoque_qtd: 20,
      destaque: true,
      ativo: true,
      somente_balcao: false,
      promo_ativo: true,
      promo_tipo: "percent",
      promo_valor: 10,
      imagem_url: "",
    },
  ];

  if (formato === "csv") {
    const cols = Object.keys(exemplo[0]);
    _impexpBaixarCSV(exemplo, cols, "template_produtos.csv");
  } else {
    _impexpBaixarJSON(exemplo, "template_produtos.json");
  }
}

// ─────────────────────────────────────────────────────────────
//  IMPORTAÇÃO — parse e preview
// ─────────────────────────────────────────────────────────────
async function impexpProcessarArquivo(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert("Arquivo muito grande (máx 5 MB).");
    return;
  }

  const ext = file.name.split(".").pop().toLowerCase();
  const texto = await file.text();

  try {
    if (ext === "json") {
      _impexpDadosImport = JSON.parse(texto);
      if (!Array.isArray(_impexpDadosImport))
        _impexpDadosImport = [_impexpDadosImport];
    } else if (ext === "csv") {
      _impexpDadosImport = _impexpParsarCSV(texto);
    } else {
      alert("Formato não suportado. Use .csv ou .json");
      return;
    }
    _impexpRenderizarPreview(_impexpDadosImport);
  } catch (e) {
    alert("Erro ao ler arquivo: " + e.message);
  }
}

function _impexpParsarCSV(texto) {
  const linhas = texto
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  if (linhas.length < 2) throw new Error("CSV vazio ou sem dados.");

  // Parser simples que respeita campos entre aspas
  const parseLinha = (linha) => {
    const resultado = [];
    let campo = "",
      dentro = false;
    for (let i = 0; i < linha.length; i++) {
      const ch = linha[i];
      if (ch === '"') {
        if (dentro && linha[i + 1] === '"') {
          campo += '"';
          i++;
        } else dentro = !dentro;
      } else if (ch === "," && !dentro) {
        resultado.push(campo);
        campo = "";
      } else {
        campo += ch;
      }
    }
    resultado.push(campo);
    return resultado;
  };

  // Tenta mapear cabeçalho — aceita label PT ou key EN
  const _labelParaKey = (label) => {
    const norm = label.trim().toLowerCase();
    const found = _IMPEXP_COLUNAS.find(
      (c) => c.key.toLowerCase() === norm || c.label.toLowerCase() === norm,
    );
    return found ? found.key : norm;
  };

  const cabecalho = parseLinha(linhas[0]).map(_labelParaKey);
  return linhas
    .slice(1)
    .filter((l) => l.trim())
    .map((linha) => {
      const vals = parseLinha(linha);
      const obj = {};
      cabecalho.forEach((k, i) => {
        let v = (vals[i] ?? "").trim();
        // Coerce tipos
        if (["preco", "estoque_qtd", "promo_valor"].includes(k))
          v = v === "" ? null : parseFloat(v) || 0;
        if (
          ["destaque", "ativo", "somente_balcao", "promo_ativo"].includes(k)
        ) {
          v = ["true", "1", "sim", "yes"].includes(
            (v || "").toString().toLowerCase(),
          );
        }
        obj[k] = v;
      });
      return obj;
    });
}

function _impexpRenderizarPreview(dados) {
  const wrap = document.getElementById("impexp-preview-wrap");
  const info = document.getElementById("impexp-preview-info");
  const thead = document.getElementById("impexp-preview-thead");
  const tbody = document.getElementById("impexp-preview-tbody");
  const errosEl = document.getElementById("impexp-erros");
  if (!wrap || !thead || !tbody) return;

  // Valida linhas
  const erros = [];
  dados.forEach((row, i) => {
    if (!row.nome || String(row.nome).trim() === "")
      erros.push(`Linha ${i + 2}: campo "Nome" obrigatório`);
    if (row.preco == null || isNaN(row.preco))
      erros.push(`Linha ${i + 2}: campo "Preço" inválido`);
  });

  if (errosEl) {
    if (erros.length) {
      errosEl.style.display = "block";
      errosEl.innerHTML = `
        <div style="background:#fef2f2;border:1.5px solid #fca5a5;border-radius:8px;padding:10px 14px;font-size:0.78rem;color:#991b1b">
          <b>⚠️ ${erros.length} problema(s) encontrado(s):</b>
          <ul style="margin:6px 0 0 16px;padding:0">${erros
            .slice(0, 5)
            .map((e) => `<li>${e}</li>`)
            .join("")}
            ${erros.length > 5 ? `<li>… e mais ${erros.length - 5}</li>` : ""}
          </ul>
        </div>`;
    } else {
      errosEl.style.display = "none";
    }
  }

  if (info) {
    const novos = dados.filter(
      (r) => !_todosProdutos?.find((p) => p.nome === r.nome),
    ).length;
    const update = dados.length - novos;
    info.innerHTML = `
      <span style="color:#16a34a;font-weight:700">${dados.length} linha(s)</span> — 
      <span style="color:#2563eb">${novos} novo(s)</span> · 
      <span style="color:#d97706">${update} atualização(ões)</span>`;
  }

  // Cabeçalho
  const cols = Object.keys(dados[0] || {});
  thead.innerHTML = `<tr>${cols.map((c) => `<th style="padding:6px 10px;text-align:left;font-size:0.72rem;color:#6b7280;white-space:nowrap">${c}</th>`).join("")}</tr>`;

  // Primeiras 20 linhas
  tbody.innerHTML = dados
    .slice(0, 20)
    .map(
      (row, i) => `
    <tr style="background:${i % 2 === 0 ? "#fff" : "#f9fafb"}">
      ${cols
        .map((c) => {
          const v = row[c];
          const display = v === true ? "✅" : v === false ? "—" : (v ?? "");
          return `<td style="padding:5px 10px;font-size:0.75rem;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis">${display}</td>`;
        })
        .join("")}
    </tr>`,
    )
    .join("");

  if (dados.length > 20) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${cols.length}" style="padding:8px;text-align:center;color:#888;font-size:0.75rem">… e mais ${dados.length - 20} linha(s)</td>`;
    tbody.appendChild(tr);
  }

  wrap.style.display = "block";
  document.getElementById("impexp-salvar-label").textContent = erros.length
    ? `Salvar mesmo assim (${dados.length} produtos)`
    : `Salvar ${dados.length} produto(s) no banco`;
}

function impexpLimparPreview() {
  _impexpDadosImport = [];
  const wrap = document.getElementById("impexp-preview-wrap");
  if (wrap) wrap.style.display = "none";
  const fi = document.getElementById("impexp-file-input");
  if (fi) fi.value = "";
}

// ─────────────────────────────────────────────────────────────
//  IMPORTAÇÃO — salvar no banco (upsert por nome)
// ─────────────────────────────────────────────────────────────
async function impexpSalvar() {
  if (!_impexpDadosImport.length) return;

  const btn = document.querySelector("#impexp-preview-wrap .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Salvando…";
  }

  // Normaliza os dados
  const payload = _impexpDadosImport
    .filter((r) => r.nome && String(r.nome).trim())
    .map((r) => ({
      nome: String(r.nome).trim(),
      descricao: r.descricao || "",
      preco: parseInt(r.preco) || 0,
      categoria_slug: r.categoria_slug || null,
      subcategoria_slug: r.subcategoria_slug || null,
      unidade_venda: r.unidade_venda || null,
      estoque_qtd: r.estoque_qtd != null ? parseInt(r.estoque_qtd) : null,
      destaque: !!r.destaque,
      ativo: r.ativo !== false && r.ativo !== 0,
      somente_balcao: !!r.somente_balcao,
      promo_ativo: !!r.promo_ativo,
      promo_tipo: r.promo_tipo || "percent",
      promo_valor: r.promo_valor ? parseFloat(r.promo_valor) : null,
      imagem_url: r.imagem_url || "",
    }));

  // Divide em lotes de 100 para não estourar limites do Supabase
  const LOTE = 100;
  let salvos = 0,
    erros = 0;

  for (let i = 0; i < payload.length; i += LOTE) {
    const lote = payload.slice(i, i + LOTE);
    const { error } = await supa
      .from("produtos")
      .upsert(lote, { onConflict: "nome", ignoreDuplicates: false });
    if (error) {
      console.error("impexpSalvar lote:", error.message);
      erros += lote.length;
    } else salvos += lote.length;
    if (btn) btn.textContent = `Salvando… (${salvos}/${payload.length})`;
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = `Salvar ${payload.length} produto(s) no banco`;
  }

  if (erros === 0) {
    if (typeof mostrarToast === "function")
      mostrarToast(
        `✅ ${salvos} produto(s) importado(s) com sucesso!`,
        "success",
        3000,
      );
    else alert(`✅ ${salvos} produto(s) importado(s)!`);
    impexpFechar();
    carregarProdutos();
  } else {
    alert(
      `⚠️ ${salvos} produto(s) salvos, ${erros} com erro. Verifique o console.`,
    );
  }
}

function imprimirCodigoBarras(codigo, nomeProduto, preco) {
  if (!codigo) {
    alert("Este produto não possui um código de barras cadastrado.");
    return;
  }

  // 1. Cria o iframe oculto
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.opacity = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "none";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;

  // 2. Injeta a estrutura HTML usando innerHTML (Seguro e aceito pelos navegadores)
  doc.body.innerHTML = `
        <div class="title">${nomeProduto}</div>
        <svg id="barcode"></svg>
        <div class="price">${preco}</div>
    `;

  // 3. Injeta o CSS diretamente no head do iframe
  const style = doc.createElement("style");
  style.textContent = `
        @page { size: auto; margin: 0mm; }
        body {
            font-family: 'Arial', sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 5px;
            text-align: center;
        }
        .title { font-size: 10px; font-weight: bold; margin-bottom: 2px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
        .price { font-size: 12px; font-weight: bold; margin-top: 2px; }
        svg { max-width: 100%; height: auto; }
    `;
  doc.head.appendChild(style);

  // 4. Cria e carrega o script do JsBarcode dinamicamente
  const script = doc.createElement("script");
  script.src =
    "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js";

  // O pulo do gato: Só executa quando o script terminar de baixar dentro do iframe
  // Só executa quando o script terminar de baixar dentro do iframe
  script.onload = function () {
    try {
      // Testa se tem 13 dígitos para sugerir EAN13 inicialmente
      let formatoSugerido = /^\d{13}$/.test(codigo) ? "EAN13" : "CODE128";

      try {
        // Tenta renderizar no formato sugerido
        iframe.contentWindow.JsBarcode("#barcode", codigo, {
          format: formatoSugerido,
          width: 2,
          height: 40,
          displayValue: true,
          fontSize: 10,
          margin: 0,
        });
      } catch (validationError) {
        // Se der erro no EAN13 (dígito verificador inválido), assume o CODE128 como fallback seguro
        console.warn(
          `Código inválido para EAN13. Forçando CODE128 para evitar quebra no fluxo.`,
        );

        iframe.contentWindow.JsBarcode("#barcode", codigo, {
          format: "CODE128",
          width: 2,
          height: 40,
          displayValue: true,
          fontSize: 10,
          margin: 0,
        });
      }

      // Foca e dispara a impressão
      iframe.contentWindow.focus();
      setTimeout(() => {
        iframe.contentWindow.print();
        // Remove o iframe do documento principal após abrir a tela de impressão
        document.body.removeChild(iframe);
      }, 300);
    } catch (err) {
      console.error("Erro crítico ao gerar código de barras:", err);
      document.body.removeChild(iframe);
    }
  };

  script.onerror = function () {
    console.error("Erro ao carregar a biblioteca de código de barras.");
    document.body.removeChild(iframe);
  };

  // Apensa o script no head para iniciar o download
  doc.head.appendChild(script);
}

// ============================================================
//  PDV – SELEÇÃO DE CLIENTES PARA "NA NOTA"
// ============================================================

let _pdvClienteSelecionadoId = null;
let _pdvClientesCache = [];

/**
 * Carrega a lista de clientes cadastrados para o dropdown do PDV.
 */
async function pdvCarregarClientes() {
  const { data, error } = await supa
    .from('clientes')
    .select('id, nome, telefone')
    .order('nome');
  if (error) {
    console.warn('pdvCarregarClientes:', error.message);
    return;
  }
  _pdvClientesCache = data || [];
}

/**
 * Atualiza a interface do PDV quando a forma de pagamento é "NaNota".
 * Mostra o seletor de clientes.
 */
function pdvAtualizarClienteNota() {
  const pag = document.getElementById('balcao-pag')?.value;
  const container = document.getElementById('pdv-cliente-nota-container');
  if (!container) return;

  if (pag === 'NaNota') {
    container.style.display = 'block';
    if (_pdvClientesCache.length === 0) pdvCarregarClientes();
    // Preenche o campo de busca com o nome/telefone atual, se houver
    const nomeCliente = document.getElementById('balcao-cliente')?.value || '';
    const telCliente = document.getElementById('balcao-telefone')?.value || '';
    const buscaInput = document.getElementById('pdv-cliente-busca');
    if (buscaInput && (nomeCliente || telCliente)) {
      buscaInput.value = nomeCliente + (telCliente ? ` (${telCliente})` : '');
    }
  } else {
    container.style.display = 'none';
    pdvEsconderClienteDropdown(true);
  }
}

/**
 * Renderiza a lista de clientes filtrada dentro do dropdown customizado
 * (substitui o antigo <datalist>, que deixava o navegador assumir o
 * autocomplete e preencher os campos com dados salvos incorretos).
 */
function _pdvRenderClienteDropdown(lista) {
  const dropdown = document.getElementById('pdv-cliente-dropdown');
  if (!dropdown) return;

  if (!lista.length) {
    dropdown.innerHTML = `
      <div style="padding:10px 12px;font-size:0.82rem;color:#94a3b8;">
        Nenhum cliente encontrado. Use "+ Novo" para cadastrar.
      </div>`;
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = lista
    .slice(0, 30)
    .map(c => `
      <div class="pdv-cliente-dropdown-item"
           onmousedown="pdvSelecionarClienteDropdown(${c.id})"
           style="padding:9px 12px;font-size:0.87rem;cursor:pointer;border-bottom:1px solid #f1f5f9;"
           onmouseover="this.style.background='#f0f9ff'"
           onmouseout="this.style.background='#fff'">
        <div style="font-weight:600;color:#1e293b;">${c.nome}</div>
        ${c.telefone ? `<div style="font-size:0.75rem;color:#64748b;">${c.telefone}</div>` : ''}
      </div>`)
    .join('');
  dropdown.style.display = 'block';
}

/**
 * Filtra os clientes conforme o usuário digita (nome ou telefone).
 * Não depende mais do <datalist>/autocomplete nativo do navegador.
 */
function pdvFiltrarClienteDropdown(input) {
  // Qualquer digitação invalida uma seleção anterior até que o
  // usuário escolha explicitamente um item da lista.
  _pdvClienteSelecionadoId = null;

  const termo = input.value.trim().toLowerCase();
  const lista = termo
    ? _pdvClientesCache.filter(c =>
        c.nome.toLowerCase().includes(termo) ||
        (c.telefone || '').toLowerCase().includes(termo)
      )
    : _pdvClientesCache;

  _pdvRenderClienteDropdown(lista);

  // Mantém o campo "Cliente (opcional)" sincronizado com o texto livre
  // digitado, mas sem tentar adivinhar telefone a partir do texto —
  // isso só é preenchido ao selecionar um cliente da lista.
  const balcaoCliente = document.getElementById('balcao-cliente');
  if (balcaoCliente) balcaoCliente.value = input.value;
}

/**
 * Exibe o dropdown ao focar/clicar no campo de busca.
 */
function pdvMostrarClienteDropdown(input) {
  if (_pdvClientesCache.length === 0) {
    pdvCarregarClientes().then(() => _pdvRenderClienteDropdown(_pdvClientesCache));
  } else {
    const termo = input.value.trim().toLowerCase();
    const lista = termo
      ? _pdvClientesCache.filter(c =>
          c.nome.toLowerCase().includes(termo) ||
          (c.telefone || '').toLowerCase().includes(termo)
        )
      : _pdvClientesCache;
    _pdvRenderClienteDropdown(lista);
  }
}

/**
 * Esconde o dropdown. Usa um pequeno atraso para que o clique num item
 * (onmousedown) seja processado antes do blur fechar a lista.
 */
function pdvEsconderClienteDropdown(imediato = false) {
  const fechar = () => {
    const dropdown = document.getElementById('pdv-cliente-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  };
  if (imediato) fechar();
  else setTimeout(fechar, 150);
}

/**
 * Seleciona um cliente cadastrado a partir do dropdown customizado.
 */
function pdvSelecionarClienteDropdown(id) {
  const match = _pdvClientesCache.find(c => c.id === id);
  if (!match) return;

  _pdvClienteSelecionadoId = match.id;
  const buscaInput = document.getElementById('pdv-cliente-busca');
  if (buscaInput) buscaInput.value = match.nome + (match.telefone ? ` (${match.telefone})` : '');
  document.getElementById('balcao-cliente').value = match.nome;
  document.getElementById('balcao-telefone').value = match.telefone || '';

  pdvEsconderClienteDropdown(true);
}

/**
 * Abre um modal simples para cadastrar um novo cliente.
 */
function pdvAbrirCadastroCliente() {
  document.getElementById('pdv-modal-cadastro-cliente')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pdv-modal-cadastro-cliente';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 99999; display: flex; align-items: center; justify-content: center;
    padding: 20px;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div style="background: #fff; border-radius: 16px; padding: 24px; max-width: 380px; width: 100%;">
      <h3 style="margin-top: 0; margin-bottom: 16px;">📝 Cadastrar Cliente</h3>
      <div style="margin-bottom: 12px;">
        <label style="display: block; font-weight: 600; font-size: 0.85rem; margin-bottom: 4px;">Nome *</label>
        <input id="pdv-novo-cliente-nome" type="text" class="form-control" placeholder="Ex: João Silva" style="width: 100%;">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; font-weight: 600; font-size: 0.85rem; margin-bottom: 4px;">Telefone *</label>
        <input id="pdv-novo-cliente-tel" type="text" class="form-control" placeholder="Ex: 595981234567" style="width: 100%;">
      </div>
      <div style="display: flex; gap: 8px;">
        <button onclick="pdvSalvarNovoCliente()" style="flex: 2; padding: 10px; background: #1a7a2e; color: #fff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer;">
          Salvar
        </button>
        <button onclick="this.closest('#pdv-modal-cadastro-cliente').remove()" style="flex: 1; padding: 10px; background: #f0f0f0; border: none; border-radius: 8px; cursor: pointer;">
          Cancelar
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('pdv-novo-cliente-nome')?.focus(), 100);
}

/**
 * Salva o novo cliente e o seleciona no PDV.
 */
async function pdvSalvarNovoCliente() {
  const nome = document.getElementById('pdv-novo-cliente-nome')?.value.trim();
  const telefone = document.getElementById('pdv-novo-cliente-tel')?.value.trim();
  if (!nome || !telefone) {
    alert('Preencha nome e telefone.');
    return;
  }

  // Verifica se já existe cliente com esse telefone
  const { data: existing } = await supa
    .from('clientes')
    .select('id')
    .eq('telefone', telefone)
    .maybeSingle();
  if (existing) {
    alert('Já existe um cliente com este telefone. Selecionando-o...');
    _pdvClienteSelecionadoId = existing.id;
    const { data: cli } = await supa.from('clientes').select('nome, telefone').eq('id', existing.id).single();
    if (cli) {
      document.getElementById('balcao-cliente').value = cli.nome;
      document.getElementById('balcao-telefone').value = cli.telefone;
    }
    document.getElementById('pdv-modal-cadastro-cliente')?.remove();
    pdvCarregarClientes();
    return;
  }

  // Insere novo cliente
  const { data: novo, error } = await supa
    .from('clientes')
    .insert([{ nome, telefone, cashback_saldo: 0, total_gasto: 0 }])
    .select('id, nome, telefone')
    .single();

  if (error) {
    alert('Erro ao cadastrar cliente: ' + error.message);
    return;
  }

  _pdvClientesCache.push(novo);
  _pdvClientesCache.sort((a, b) => a.nome.localeCompare(b.nome));
  _pdvClienteSelecionadoId = novo.id;
  document.getElementById('balcao-cliente').value = novo.nome;
  document.getElementById('balcao-telefone').value = novo.telefone || '';
  document.getElementById('pdv-modal-cadastro-cliente')?.remove();

  const buscaInput = document.getElementById('pdv-cliente-busca');
  if (buscaInput) buscaInput.value = novo.nome + (novo.telefone ? ` (${novo.telefone})` : '');
}

// ──────────────────────────────────────────────────────────────
//  INTEGRAÇÃO COM O FLUXO EXISTENTE
// ──────────────────────────────────────────────────────────────

// Salva a referência da função original para não perdê-la
const _origAtualizarInfoPagPDV = window.atualizarInfoPagPDV;

// Sobrescreve a função para incluir a atualização do seletor de cliente
window.atualizarInfoPagPDV = function(total) {
  if (typeof _origAtualizarInfoPagPDV === 'function') {
    _origAtualizarInfoPagPDV(total);
  }
  pdvAtualizarClienteNota();
};

// Patch na função salvarPedidoBalcao para incluir cliente_id
// (o bloco já foi adicionado dentro da função original, mas garantimos que
// a variável _pdvClienteSelecionadoId esteja disponível)
// ATENÇÃO: a função salvarPedidoBalcao já foi modificada no seu código,
// portanto não a sobrescrevemos novamente aqui. Apenas garantimos que
// as variáveis e funções acima estejam definidas.

// ──────────────────────────────────────────────────────────────
//  INICIALIZAÇÃO (executar no DOMContentLoaded)
// ──────────────────────────────────────────────────────────────

// Esta parte deve ser chamada após o carregamento da página.
// Se você já tem um listener DOMContentLoaded, adicione estas linhas lá.

// Exemplo de como deve ser chamado (coloque dentro do seu DOMContentLoaded):
/*
  // Cria o container do seletor de cliente se não existir
  
*/

/**
 * Registra uma movimentação de caixa (entrada/saída) vinculada a uma sessão.
 * @param {Object} params
 * @param {string} params.tipo - 'entrada' ou 'saida'
 * @param {number} params.valor
 * @param {string} params.descricao
 * @param {string} params.usuario_email
 * @param {number} params.sessao_id
 * @param {string} params.forma_pagamento - opcional
 * @returns {Promise<boolean>}
 */
async function registrarMovimentacaoCaixa(params) {
  try {
    const { tipo, valor, descricao, usuario_email, sessao_id, forma_pagamento } = params;
    if (!sessao_id) throw new Error('Sessão de caixa não informada');
    const insert = {
      tipo: tipo,
      valor: valor,
      descricao: descricao || '',
      usuario_email: usuario_email || 'admin',
      sessao_id: sessao_id,
      forma_pagamento: forma_pagamento || null,
    };
    const { error } = await supa.from('movimentacoes_caixa').insert([insert]);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('registrarMovimentacaoCaixa:', e);
    return false;
  }
}
