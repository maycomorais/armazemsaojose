-- =================================================================
--  PLATAFORMA WHITE LABEL — SQL COMPLETO E CONSOLIDADO
--  Versão 2.0
--
--  ► PROJETO NOVO    → execute este arquivo INTEIRO no SQL Editor
--  ► PROJETO EXISTENTE → execute APENAS a Seção 9 (Migration Incremental)
--
--  Índice das seções:
--    1. Extensões
--    2. Tabelas principais
--    3. Índices
--    4. Row Level Security (RLS)
--    5. Storage (bucket "produtos")
--    6. Realtime
--    7. Promover usuário para adminMaster
--    8. Verificações úteis
--    9. Migration Incremental (bancos existentes)
-- =================================================================


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 1 — EXTENSÕES
-- ═════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 2 — TABELAS PRINCIPAIS
-- ═════════════════════════════════════════════════════════════════

-- ── perfis_acesso ─────────────────────────────────────────────────
-- Vinculado ao Supabase Auth (auth.users)
-- Hierarquia: adminMaster > dono > gerente > funcionario > garcom
CREATE TABLE IF NOT EXISTS perfis_acesso (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  cargo         TEXT NOT NULL DEFAULT 'funcionario'
                CHECK (cargo IN ('adminMaster','dono','gerente','funcionario','garcom')),
  nome_display  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);


-- ── configuracoes ─────────────────────────────────────────────────
-- Linha única (id = 1). Todos os dados globais da loja ficam aqui.
CREATE TABLE IF NOT EXISTS configuracoes (
  id                          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- ── Identidade ──────────────────────────────────────────────────
  nome_restaurante            TEXT          DEFAULT '',
  descricao_loja              TEXT          DEFAULT '',
  url_loja                    TEXT          DEFAULT '',
  telefone_loja               TEXT          DEFAULT '',
  whatsapp_loja               TEXT          DEFAULT '',   -- só dígitos
  logo_url                    TEXT          DEFAULT '',
  icone_url                   TEXT          DEFAULT '',   -- ícone PWA

  -- ── Pagamento ───────────────────────────────────────────────────
  chave_pix                   TEXT          DEFAULT '',
  nome_pix                    TEXT          DEFAULT '',
  dados_alias                 TEXT          DEFAULT '',   -- número/alias PY
  nome_alias                  TEXT          DEFAULT '',   -- titular alias
  -- Maquininhas de cartão (múltiplas operadoras)
  -- Estrutura: [{"nome":"Cielo","taxas":{"debito":1.5,"credito":2.5,"parcelado":3.0}}]
  maquininhas_cartao          JSONB         DEFAULT '[]'::JSONB,

  -- ── Localização e Delivery ──────────────────────────────────────
  coord_lat                   DOUBLE PRECISION DEFAULT 0,
  coord_lng                   DOUBLE PRECISION DEFAULT 0,
  tabela_frete                JSONB         DEFAULT NULL,
  -- Estrutura tabela_frete: [{"km_ate":2,"loja":6000,"motoboy":6000,"acombinar":false}, ...]
  limite_distancia_km         NUMERIC(5,1)  DEFAULT NULL, -- raio máx de entrega (NULL = sem limite)
  delivery_aberto             BOOLEAN       DEFAULT TRUE,
  aviso_delivery              TEXT          DEFAULT '',

  -- ── Operação ────────────────────────────────────────────────────
  loja_aberta                 BOOLEAN       DEFAULT TRUE,
  cotacao_real                NUMERIC(10,2) DEFAULT 1100,
  taxa_motoboy_base           INTEGER       DEFAULT 0,    -- fallback valor entrega
  ajuda_combustivel           INTEGER       DEFAULT 0,    -- combustível diário por motoboy

  -- ── Horários ────────────────────────────────────────────────────
  horarios_semanais           JSONB         DEFAULT NULL,
  -- Estrutura: {"seg":[{"abre":"08:00","fecha":"22:00"}],"ter":[...],...}
  horario_extra_hoje          JSONB         DEFAULT NULL,

  -- ── Banners / Promoções ─────────────────────────────────────────
  -- Banner 1
  banner_imagem               TEXT          DEFAULT '',
  banner_produto_id           INTEGER       DEFAULT NULL,
  banner_desconto_tipo        TEXT          DEFAULT NULL, -- 'percentual' ou 'fixo'
  banner_desconto_valor       NUMERIC(10,2) DEFAULT NULL,
  -- Banner 2
  banner2_imagem              TEXT          DEFAULT '',
  banner2_produto_id          INTEGER       DEFAULT NULL,
  banner2_desconto_tipo       TEXT          DEFAULT NULL, -- 'percentual' ou 'fixo'
  banner2_desconto_valor      NUMERIC(10,2) DEFAULT NULL,

  -- ── Visual ──────────────────────────────────────────────────────
  cor_primaria                TEXT          DEFAULT '#1a7a2e',
  cor_secundaria              TEXT          DEFAULT '#155c24',

  -- ── Adicionais globais ──────────────────────────────────────────
  -- Estrutura: [{"nome":"Adicional X","preco":2000}]
  extras_globais              JSONB         DEFAULT '[]'::JSONB,
  -- Categorias que exibem os adicionais globais (NULL = todas)
  -- Estrutura: ["slug-cat-1","slug-cat-2"] ou NULL
  extras_globais_categorias   JSONB         DEFAULT NULL,

  -- ── Financeiro / Caixa ──────────────────────────────────────────
  -- Valor em efetivo que aciona sangria automática (NULL = desabilitado)
  sangria_limite              INTEGER       DEFAULT NULL,
  -- Status de bloqueio por operador
  -- Estrutura: {"email@loja.com":{"bloqueado":false,"autorizado_por":null,"bloqueado_em":null}}
  caixa_status                JSONB         DEFAULT '{}'::JSONB,

  -- ── Features (controladas pelo adminMaster) ─────────────────────
  features_ativas             JSONB         DEFAULT '{
    "tabs": {
      "pedidos": true, "cozinha": true, "pdv": true,
      "financeiro": true, "inventario": true, "equipe": true,
      "configuracoes": true, "dashboard": true
    },
    "tipos_produto": {
      "padrao": true, "bebida": true, "lanche": true, "pizza": true,
      "acai": true, "shake": true, "suco": true, "sorvete": true,
      "montavel": true, "combo": true, "variacoes": true, "kg": true
    },
    "funcionalidades": {
      "delivery": true, "retirada": true, "local": true, "balcao": true,
      "cupons": true, "factura": true, "multipagamento": true, "agendamento": true
    }
  }'::JSONB
);

-- Garante que sempre existe a linha id=1
INSERT INTO configuracoes (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ── categorias ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categorias (
  id                SERIAL PRIMARY KEY,
  slug              TEXT      NOT NULL UNIQUE,
  nome              TEXT      NOT NULL DEFAULT '',   -- usado internamente
  nome_exibicao     TEXT      NOT NULL DEFAULT '',   -- exibido no cardápio
  descricao         TEXT      DEFAULT '',
  emoji             TEXT      DEFAULT '',
  cor               TEXT      DEFAULT '#1a7a2e',
  ordem             INTEGER   DEFAULT 0,
  ativa             BOOLEAN   DEFAULT TRUE,
  hora_inicio       TIME      DEFAULT NULL,
  hora_fim          TIME      DEFAULT NULL,
  dias_semana       TEXT[]    DEFAULT NULL,          -- ['seg','ter','qua'...]
  horarios_semanais JSONB     DEFAULT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: sincroniza nome e nome_exibicao
CREATE OR REPLACE FUNCTION sync_cat_nome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nome IS NOT NULL AND NEW.nome != ''
     AND (NEW.nome_exibicao IS NULL OR NEW.nome_exibicao = '') THEN
    NEW.nome_exibicao := NEW.nome;
  END IF;
  IF NEW.nome_exibicao IS NOT NULL AND NEW.nome_exibicao != ''
     AND (NEW.nome IS NULL OR NEW.nome = '') THEN
    NEW.nome := NEW.nome_exibicao;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_cat_nome ON categorias;
CREATE TRIGGER trg_sync_cat_nome
  BEFORE INSERT OR UPDATE ON categorias
  FOR EACH ROW EXECUTE FUNCTION sync_cat_nome();


-- ── subcategorias ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subcategorias (
  id              SERIAL PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  nome_exibicao   TEXT    NOT NULL,
  categoria_slug  TEXT    REFERENCES categorias(slug) ON DELETE CASCADE,
  ordem           INTEGER DEFAULT 0,
  ativa           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── produtos ──────────────────────────────────────────────────────
-- montagem_config JSONB — estrutura varia por tipo de produto:
--
-- Simples/Lanche/Bebida:
--   { "__tipo": "padrao" }
--
-- Variações:
--   { "__tipo": "variacoes", "variacoes": [{"nome":"P","preco":10000,"ativo":true}, ...] }
--
-- Pizza:
--   { "__tipo": "pizza",
--     "tipos_pizza": [{"nome":"Tradicional"}, {"nome":"Especial"}, {"nome":"Doce"}],
--     "tamanhos": [{
--       "nome":"Grande", "fatias":8, "cm":35,
--       "precos": {"Tradicional":60000, "Especial":65000, "Doce":60000},
--       "bordas": {"Cheddar":10000, "Catupiry":12000},
--       "max_sabores": 2
--     }],
--     "sabores": [{"nome":"Frango", "tipo":"Tradicional", "desc":"", "img":""}],
--     "bordas": [{"nome":"Cheddar"}, {"nome":"Catupiry"}]
--   }
--
-- Açaí:
--   { "__tipo": "acai",
--     "tamanhos": [{"nome":"300ml","preco":12000,"img":""}],
--     "acompanhamentos": [{"nome":"Granola","img":"","preco":0}],
--     "etapas": [{"titulo":"Frutas","max":2,"itens":[{"nome":"Morango","img":"","preco":0}]}],
--     "variacoes": [{"nome":"Tradicional","preco":0}]
--   }
--
-- Shake:
--   { "__tipo": "shake",
--     "shake": {
--       "tamanhos": [{"nome":"400ml","ml":400,"preco":15000}],
--       "sabores":  [{"nome":"Chocolate","preco":0,"img":""}]
--     }
--   }
--
-- Suco:
--   { "__tipo": "suco",
--     "tamanhos": [{"nome":"300ml","preco":8000}],
--     "etapas": [{"titulo":"Frutas","max":1,"itens":[{"nome":"Laranja","img":"","preco":0}]}]
--   }
--
-- Sorvete:
--   { "__tipo": "sorvete",
--     "tamanhos": [{"nome":"1 Bola","qtd_bolas":1,"preco":5000},{"nome":"2 Bolas","qtd_bolas":2,"preco":9000}],
--     "sabores": [{"nome":"Chocolate","img":"","preco":0}],
--     "etapas": [{"titulo":"Coberturas","max":1,"itens":[{"nome":"Calda de Chocolate","img":"","preco":500}]}],
--     "variacoes": [{"nome":"Casquinha","preco":0},{"nome":"Copinho","preco":500}]
--   }
--
-- Montável:
--   { "__tipo": "montavel",
--     "etapas": [{"titulo":"Proteína","max":1,"itens":[{"nome":"Frango","img":"","preco":0}]}]
--   }
--
-- Combo:
--   { "__tipo": "combo",
--     "descricao_livre": "1 lanche + 1 bebida + 1 batata",
--     "itens_combo": [123, 456]   -- IDs de produtos (opcional)
--   }
--
-- Kg:
--   { "__tipo": "kg", "preco_kg": 35000 }
--
CREATE TABLE IF NOT EXISTS produtos (
  id                 SERIAL PRIMARY KEY,
  nome               TEXT    NOT NULL,
  descricao          TEXT    DEFAULT '',
  preco              INTEGER DEFAULT 0,     -- preço base (menor tamanho se variável)
  imagem_url         TEXT    DEFAULT '',
  categoria_slug     TEXT    REFERENCES categorias(slug) ON DELETE SET NULL,
  subcategoria_slug  TEXT    DEFAULT NULL,
  ativo              BOOLEAN DEFAULT TRUE,
  pausado            BOOLEAN DEFAULT FALSE,
  somente_balcao     BOOLEAN DEFAULT FALSE,
  destaque           BOOLEAN DEFAULT FALSE,
  ordem              INTEGER DEFAULT 0,
  e_montavel         BOOLEAN DEFAULT FALSE,
  montagem_config    JSONB   DEFAULT NULL,
  adicionais         JSONB   DEFAULT '[]'::JSONB,
  inventario_id      INTEGER DEFAULT NULL,
  estoque_qtd        INTEGER DEFAULT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- FK subcategoria (safe — cria só se não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_produtos_subcat' AND table_name = 'produtos'
  ) THEN
    ALTER TABLE produtos
      ADD CONSTRAINT fk_produtos_subcat
        FOREIGN KEY (subcategoria_slug)
        REFERENCES subcategorias(slug) ON DELETE SET NULL;
  END IF;
END $$;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_produtos_updated_at ON produtos;
CREATE TRIGGER trg_produtos_updated_at
  BEFORE UPDATE ON produtos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── inventario ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventario (
  id                SERIAL PRIMARY KEY,
  nome              TEXT          NOT NULL,
  unidade           TEXT          DEFAULT 'un',
  quantidade        NUMERIC(10,3) DEFAULT 0,
  quantidade_minima NUMERIC(10,3) DEFAULT NULL,   -- alerta de estoque baixo
  custo_unit        INTEGER       DEFAULT 0,
  produto_id        INTEGER       DEFAULT NULL,   -- vínculo com produto (opcional)
  perecivel         BOOLEAN       DEFAULT FALSE,
  data_validade     DATE          DEFAULT NULL,
  observacoes       TEXT          DEFAULT NULL,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);


-- ── inventario_movimentos ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventario_movimentos (
  id              SERIAL PRIMARY KEY,
  inventario_id   INTEGER REFERENCES inventario(id) ON DELETE CASCADE,
  tipo            TEXT    NOT NULL CHECK (tipo IN ('add','sub','ajuste','fechamento')),
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 0,
  motivo          TEXT    DEFAULT '',
  usuario_email   TEXT    DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── motoboys ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS motoboys (
  id         SERIAL PRIMARY KEY,
  nome       TEXT    NOT NULL,
  telefone   TEXT    DEFAULT '',
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ── cupons ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cupons (
  id              SERIAL PRIMARY KEY,
  codigo          TEXT          NOT NULL UNIQUE,
  tipo            TEXT          NOT NULL CHECK (tipo IN ('percentual','fixo','frete')),
  valor           NUMERIC(10,2) DEFAULT 0,
  minimo          NUMERIC(10,2) DEFAULT 0,       -- valor mínimo de compra para usar
  limite_uso      INTEGER       DEFAULT NULL,    -- número máximo de usos (NULL = ilimitado)
  usos_realizados INTEGER       DEFAULT 0,
  ativo           BOOLEAN       DEFAULT TRUE,
  validade        DATE          DEFAULT NULL,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);


-- ── pedidos ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pedidos (
  id                            SERIAL PRIMARY KEY,
  uid_temporal                  TEXT    DEFAULT '',
  status                        TEXT    DEFAULT 'pendente'
    CHECK (status IN ('pendente','em_preparo','pronto_entrega','saiu_entrega','entregue','cancelado')),
  tipo_entrega                  TEXT    DEFAULT 'delivery'
    CHECK (tipo_entrega IN ('delivery','retirada','local','balcao')),

  -- Itens
  itens                         JSONB   DEFAULT '[]'::JSONB,

  -- Valores
  subtotal                      INTEGER DEFAULT 0,
  desconto_cupom                INTEGER DEFAULT 0,
  desconto_pdv_valor            INTEGER DEFAULT 0,   -- desconto manual aplicado no PDV
  desconto_pdv_tipo             TEXT    DEFAULT NULL, -- 'percentual' ou 'fixo'
  frete_cobrado_cliente         INTEGER DEFAULT 0,
  frete_motoboy                 INTEGER DEFAULT 0,
  frete_a_combinar              BOOLEAN DEFAULT FALSE, -- frete acima do raio configurado
  total_geral                   INTEGER DEFAULT 0,

  -- Pagamento
  forma_pagamento               TEXT    DEFAULT '',
  obs_pagamento                 TEXT    DEFAULT '',

  -- Cliente
  cliente_nome                  TEXT    DEFAULT '',
  cliente_telefone              TEXT    DEFAULT '',
  endereco_entrega              TEXT    DEFAULT '',
  geo_lat                       TEXT    DEFAULT NULL,
  geo_lng                       TEXT    DEFAULT NULL,

  -- Faturação
  dados_factura                 JSONB   DEFAULT NULL,

  -- Operadores
  motoboy_id                    INTEGER REFERENCES motoboys(id) ON DELETE SET NULL,
  garcom_id                     UUID    REFERENCES perfis_acesso(id) ON DELETE SET NULL,
  garcom_nome                   TEXT    DEFAULT NULL,

  -- Cancelamento
  cancelamento_solicitado       BOOLEAN     DEFAULT FALSE,
  cancelamento_motivo           TEXT        DEFAULT NULL,
  cancelamento_solicitado_por   TEXT        DEFAULT NULL,
  cancelamento_solicitado_em    TIMESTAMPTZ DEFAULT NULL,
  cancelamento_aprovado_por     TEXT        DEFAULT NULL,
  cancelamento_aprovado_em      TIMESTAMPTZ DEFAULT NULL,
  motivo_cancelamento           TEXT        DEFAULT NULL, -- alias de cancelamento_motivo

  -- Extras
  confirmacao_tipo              TEXT    DEFAULT NULL,
  cupom_codigo                  TEXT    DEFAULT NULL,

  -- Timestamps do ciclo de vida
  tempo_recebido                TIMESTAMPTZ DEFAULT NOW(),
  tempo_confirmado              TIMESTAMPTZ DEFAULT NULL,
  tempo_preparo_iniciado        TIMESTAMPTZ DEFAULT NULL,
  tempo_pronto                  TIMESTAMPTZ DEFAULT NULL,
  tempo_saiu_entrega            TIMESTAMPTZ DEFAULT NULL,
  tempo_entregue                TIMESTAMPTZ DEFAULT NULL,

  created_at                    TIMESTAMPTZ DEFAULT NOW()
);


-- ── solicitacoes_cancelamento ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS solicitacoes_cancelamento (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  motivo          TEXT    DEFAULT '',
  solicitado_por  TEXT    DEFAULT '',
  aprovado        BOOLEAN DEFAULT FALSE,
  aprovado_por    TEXT    DEFAULT NULL,
  aprovado_em     TIMESTAMPTZ DEFAULT NULL,
  negado          BOOLEAN DEFAULT FALSE,
  negado_por      TEXT    DEFAULT NULL,
  negado_em       TIMESTAMPTZ DEFAULT NULL,
  observacoes     TEXT    DEFAULT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── movimentacoes_caixa ───────────────────────────────────────────
-- Cada funcionário opera seu próprio caixa (usuario_email = chave).
-- Gerente/dono/adminMaster veem a soma de todos os caixas.
CREATE TABLE IF NOT EXISTS movimentacoes_caixa (
  id               SERIAL PRIMARY KEY,
  tipo             TEXT          NOT NULL, -- 'entrada','saida','fechamento','sangria','autorizacao'
  valor            NUMERIC(12,2) NOT NULL DEFAULT 0,
  descricao        TEXT          DEFAULT '',
  usuario_email    TEXT          DEFAULT '', -- operador do caixa
  -- Tipo de despesa (para saídas)
  tipo_despesa     TEXT          DEFAULT NULL,
  -- Valores: 'despesas_gerais','contas_fixas','pagamento_fornecedor',
  --          'pagamento_funcionario','pagamento_terceiros',
  --          'manutencao','retirada','motoboy','outro'
  descricao_outro  TEXT          DEFAULT NULL, -- preenchido quando tipo_despesa='outro'
  -- Autorização (para sangria/reabertura de caixa)
  autorizado_por   TEXT          DEFAULT NULL, -- email de gerente/dono que autorizou
  pedido_id        INTEGER       DEFAULT NULL, -- vínculo com pedido (quando aplicável)
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 3 — ÍNDICES
-- ═════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_pedidos_status
  ON pedidos (status);
CREATE INDEX IF NOT EXISTS idx_pedidos_created_at
  ON pedidos (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_garcom
  ON pedidos (garcom_id) WHERE garcom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_garcom_status
  ON pedidos (garcom_id, status) WHERE garcom_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_produtos_cat
  ON produtos (categoria_slug);
CREATE INDEX IF NOT EXISTS idx_produtos_ativo
  ON produtos (ativo);
CREATE INDEX IF NOT EXISTS idx_produtos_subcat
  ON produtos (subcategoria_slug);

CREATE INDEX IF NOT EXISTS idx_subcategorias_cat
  ON subcategorias (categoria_slug);

CREATE INDEX IF NOT EXISTS idx_sol_cancel_pedido
  ON solicitacoes_cancelamento (pedido_id);

CREATE INDEX IF NOT EXISTS idx_inv_mov_inv
  ON inventario_movimentos (inventario_id);

CREATE INDEX IF NOT EXISTS idx_caixa_created
  ON movimentacoes_caixa (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caixa_operador
  ON movimentacoes_caixa (usuario_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cupons_codigo
  ON cupons (codigo);


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 4 — ROW LEVEL SECURITY (RLS)
-- ═════════════════════════════════════════════════════════════════

ALTER TABLE pedidos                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracoes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfis_acesso              ENABLE ROW LEVEL SECURITY;
ALTER TABLE motoboys                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cupons                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcategorias              ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitacoes_cancelamento  ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario_movimentos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimentacoes_caixa        ENABLE ROW LEVEL SECURITY;

-- ── Políticas (idempotentes via DO $$) ───────────────────────────

-- Cardápio público: leitura anônima liberada
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='produtos'      AND policyname='anon_read_produtos')      THEN CREATE POLICY "anon_read_produtos"      ON produtos      FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='categorias'    AND policyname='anon_read_categorias')    THEN CREATE POLICY "anon_read_categorias"    ON categorias    FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='subcategorias' AND policyname='anon_read_subcats')       THEN CREATE POLICY "anon_read_subcats"       ON subcategorias FOR SELECT USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='configuracoes' AND policyname='anon_read_config')        THEN CREATE POLICY "anon_read_config"        ON configuracoes FOR SELECT USING (true); END IF;
END $$;

-- Pedidos:
--   INSERT  → bloqueado para anon/auth (só Edge Function via service_role insere)
--   SELECT  → liberado (tracking público)
--   UPDATE  → liberado (confirmação de entrega pelo cliente + admin)
--   DELETE/ALL → só autenticados
DO $$ BEGIN
  -- Remove policies de INSERT direto (segurança: só Edge Function insere)
  DROP POLICY IF EXISTS "Clientes podem inserir pedidos"    ON pedidos;
  DROP POLICY IF EXISTS "Allow insert for anon"             ON pedidos;
  DROP POLICY IF EXISTS "Enable insert for anon"            ON pedidos;
  DROP POLICY IF EXISTS "insert_pedidos"                    ON pedidos;
  DROP POLICY IF EXISTS "anon_insert_pedidos"               ON pedidos;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pedidos' AND policyname='pedidos_select_publico') THEN
    CREATE POLICY "pedidos_select_publico" ON pedidos FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pedidos' AND policyname='pedidos_update_publico') THEN
    CREATE POLICY "pedidos_update_publico" ON pedidos FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pedidos' AND policyname='auth_all_pedidos') THEN
    CREATE POLICY "auth_all_pedidos" ON pedidos FOR ALL USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- Solicitações de cancelamento: anon pode criar, autenticado gerencia
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='solicitacoes_cancelamento' AND policyname='anon_insert_solicitacoes') THEN
    CREATE POLICY "anon_insert_solicitacoes" ON solicitacoes_cancelamento FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='solicitacoes_cancelamento' AND policyname='auth_all_solicitacoes') THEN
    CREATE POLICY "auth_all_solicitacoes" ON solicitacoes_cancelamento FOR ALL USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- Demais tabelas: só autenticados
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='produtos'             AND policyname='auth_all_produtos')      THEN CREATE POLICY "auth_all_produtos"      ON produtos             FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='categorias'           AND policyname='auth_all_categorias')    THEN CREATE POLICY "auth_all_categorias"    ON categorias           FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='subcategorias'        AND policyname='auth_all_subcats')       THEN CREATE POLICY "auth_all_subcats"       ON subcategorias        FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='configuracoes'        AND policyname='auth_all_config')        THEN CREATE POLICY "auth_all_config"        ON configuracoes        FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='perfis_acesso'        AND policyname='auth_all_perfis')        THEN CREATE POLICY "auth_all_perfis"        ON perfis_acesso        FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='motoboys'             AND policyname='auth_all_motoboys')      THEN CREATE POLICY "auth_all_motoboys"      ON motoboys             FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cupons'               AND policyname='auth_all_cupons')        THEN CREATE POLICY "auth_all_cupons"        ON cupons               FOR ALL USING (auth.role()='authenticated'); END IF;
  -- Clientes anônimos precisam LER cupons para validar no checkout
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cupons'               AND policyname='anon_read_cupons')        THEN CREATE POLICY "anon_read_cupons"        ON cupons               FOR SELECT USING (ativo = true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventario'           AND policyname='auth_all_inventario')    THEN CREATE POLICY "auth_all_inventario"    ON inventario           FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='inventario_movimentos'AND policyname='auth_all_inv_mov')       THEN CREATE POLICY "auth_all_inv_mov"       ON inventario_movimentos FOR ALL USING (auth.role()='authenticated'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='movimentacoes_caixa'  AND policyname='auth_all_caixa')         THEN CREATE POLICY "auth_all_caixa"         ON movimentacoes_caixa  FOR ALL USING (auth.role()='authenticated'); END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 5 — STORAGE: bucket "produtos"
-- ► Crie o bucket MANUALMENTE em:
--   Supabase Dashboard → Storage → New Bucket
--   Nome: produtos | Public: ON
-- Depois rode as policies abaixo:
-- ═════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_public_read') THEN
    CREATE POLICY "produtos_public_read"   ON storage.objects FOR SELECT              USING  (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_insert') THEN
    CREATE POLICY "produtos_auth_insert"   ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_update') THEN
    CREATE POLICY "produtos_auth_update"   ON storage.objects FOR UPDATE TO authenticated USING  (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_delete') THEN
    CREATE POLICY "produtos_auth_delete"   ON storage.objects FOR DELETE TO authenticated USING  (bucket_id = 'produtos');
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 6 — REALTIME
-- ═════════════════════════════════════════════════════════════════

-- Habilita Realtime na tabela de pedidos (tracking e admin ao vivo)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'pedidos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pedidos;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 7 — PROMOVER USUÁRIO PARA adminMaster
-- ► Substitua 'seu@email.com' pelo email desejado e descomente
-- ═════════════════════════════════════════════════════════════════

-- Opção A — usuário já fez login pelo menos uma vez no admin:
-- UPDATE perfis_acesso SET cargo = 'adminMaster' WHERE email = 'seu@email.com';

-- Opção B — usuário criado pelo Supabase mas nunca logou no admin:
-- 1. Descubra o UUID:
--    SELECT id FROM auth.users WHERE email = 'seu@email.com';
-- 2. Insira/atualize:
-- INSERT INTO perfis_acesso (id, email, cargo, nome_display)
-- VALUES ('COLE_UUID_AQUI', 'seu@email.com', 'adminMaster', 'Admin Master')
-- ON CONFLICT (id) DO UPDATE SET cargo = 'adminMaster';

-- Verificação:
-- SELECT id, email, cargo, nome_display FROM perfis_acesso WHERE cargo = 'adminMaster';


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 8 — VERIFICAÇÕES ÚTEIS (read-only, pode rodar a qualquer hora)
-- ═════════════════════════════════════════════════════════════════

-- Listar todas as policies ativas:
-- SELECT schemaname, tablename, policyname, cmd, roles
-- FROM pg_policies
-- WHERE schemaname IN ('public','storage')
-- ORDER BY tablename, policyname;

-- Verificar colunas de configuracoes:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'configuracoes'
-- ORDER BY ordinal_position;

-- Verificar colunas de pedidos:
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'pedidos'
-- ORDER BY ordinal_position;


-- ═════════════════════════════════════════════════════════════════
-- SEÇÃO 9 — MIGRATION INCREMENTAL
-- ► Execute APENAS se já tem um banco existente (criado com versão anterior)
-- ► Todas as instruções são idempotentes (ADD COLUMN IF NOT EXISTS)
-- ═════════════════════════════════════════════════════════════════

-- ── 9.1 configuracoes ────────────────────────────────────────────

ALTER TABLE public.configuracoes
  -- Identidade (se o banco for muito antigo)
  ADD COLUMN IF NOT EXISTS nome_restaurante          TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS descricao_loja            TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS url_loja                  TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS telefone_loja             TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS whatsapp_loja             TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS logo_url                  TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS icone_url                 TEXT          DEFAULT '',
  -- Pagamento
  ADD COLUMN IF NOT EXISTS chave_pix                 TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS nome_pix                  TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS dados_alias               TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS nome_alias                TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS maquininhas_cartao         JSONB         DEFAULT '[]'::JSONB,
  -- Localização e Delivery
  ADD COLUMN IF NOT EXISTS coord_lat                 DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coord_lng                 DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS limite_distancia_km       NUMERIC(5,1)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS delivery_aberto           BOOLEAN       DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS aviso_delivery            TEXT          DEFAULT '',
  -- Operação
  ADD COLUMN IF NOT EXISTS loja_aberta               BOOLEAN       DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cotacao_real              NUMERIC(10,2) DEFAULT 1100,
  ADD COLUMN IF NOT EXISTS taxa_motoboy_base         INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ajuda_combustivel         INTEGER       DEFAULT 0,
  -- Horários
  ADD COLUMN IF NOT EXISTS horarios_semanais         JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS horario_extra_hoje        JSONB         DEFAULT NULL,
  -- Banners
  ADD COLUMN IF NOT EXISTS banner_imagem             TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner_produto_id         INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_desconto_tipo      TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner_desconto_valor     NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner2_imagem            TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS banner2_produto_id        INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner2_desconto_tipo     TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banner2_desconto_valor    NUMERIC(10,2) DEFAULT NULL,
  -- Visual
  ADD COLUMN IF NOT EXISTS cor_primaria              TEXT          DEFAULT '#1a7a2e',
  ADD COLUMN IF NOT EXISTS cor_secundaria            TEXT          DEFAULT '#155c24',
  -- Extras globais
  ADD COLUMN IF NOT EXISTS extras_globais            JSONB         DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS extras_globais_categorias JSONB         DEFAULT NULL,
  -- Financeiro / Caixa
  ADD COLUMN IF NOT EXISTS sangria_limite            INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS caixa_status              JSONB         DEFAULT '{}'::JSONB,
  -- Features
  ADD COLUMN IF NOT EXISTS features_ativas           JSONB         DEFAULT NULL;

-- Garante que loja_aberta não é NULL em registros antigos
UPDATE public.configuracoes SET loja_aberta = TRUE WHERE loja_aberta IS NULL;


-- ── 9.2 produtos ─────────────────────────────────────────────────

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS e_montavel        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS subcategoria_slug TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS somente_balcao    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS destaque          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS inventario_id     INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS estoque_qtd       INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ DEFAULT NOW();


-- ── 9.3 categorias ───────────────────────────────────────────────

ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS nome              TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS dias_semana       TEXT[]  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS horarios_semanais JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hora_inicio       TIME    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hora_fim          TIME    DEFAULT NULL;

-- Sincroniza nome ← nome_exibicao em registros antigos
UPDATE public.categorias
  SET nome = nome_exibicao
  WHERE (nome = '' OR nome IS NULL) AND nome_exibicao IS NOT NULL;


-- ── 9.4 subcategorias ────────────────────────────────────────────
-- Nota: se o banco antigo não tinha 'slug', adicione e preencha antes de criar o unique index.

ALTER TABLE public.subcategorias
  ADD COLUMN IF NOT EXISTS slug         TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS nome_exibicao TEXT DEFAULT NULL;

-- Preenche slug para registros existentes sem slug (usa id como base)
UPDATE public.subcategorias
  SET slug = 'subcat-' || id
  WHERE slug IS NULL OR slug = '';

-- Cria índice único (só se a coluna já tiver valores únicos)
CREATE UNIQUE INDEX IF NOT EXISTS subcategorias_slug_unique
  ON public.subcategorias (slug);


-- ── 9.5 pedidos ──────────────────────────────────────────────────

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS frete_a_combinar        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS desconto_pdv_valor       INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desconto_pdv_tipo        TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS garcom_nome              TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancelamento_motivo      TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado_por TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado_em  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_aprovado_por   TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelamento_aprovado_em    TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motivo_cancelamento      TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmacao_tipo         TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cupom_codigo             TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_confirmado         TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_preparo_iniciado   TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_pronto             TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_saiu_entrega       TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tempo_entregue           TIMESTAMPTZ DEFAULT NULL;


-- ── 9.6 inventario ───────────────────────────────────────────────

ALTER TABLE public.inventario
  ADD COLUMN IF NOT EXISTS quantidade_minima NUMERIC(10,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS produto_id        INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS perecivel         BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_validade     DATE          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS observacoes       TEXT          DEFAULT NULL;

-- Se o banco antigo tinha 'minimo' em vez de 'quantidade_minima', migra os dados:
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventario' AND column_name = 'minimo'
  ) THEN
    UPDATE public.inventario
      SET quantidade_minima = minimo
      WHERE quantidade_minima IS NULL AND minimo IS NOT NULL AND minimo > 0;
  END IF;
END $$;


-- ── 9.7 cupons ───────────────────────────────────────────────────

ALTER TABLE public.cupons
  ADD COLUMN IF NOT EXISTS minimo     NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS limite_uso INTEGER       DEFAULT NULL;

-- Se o banco antigo tinha 'uso_maximo' em vez de 'limite_uso', migra os dados:
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cupons' AND column_name = 'uso_maximo'
  ) THEN
    UPDATE public.cupons
      SET limite_uso = uso_maximo
      WHERE limite_uso IS NULL AND uso_maximo IS NOT NULL;
  END IF;
END $$;


-- ── 9.8 movimentacoes_caixa ──────────────────────────────────────

-- Cria a tabela se não existir (pode ter sido criada com outro nome)
CREATE TABLE IF NOT EXISTS public.movimentacoes_caixa (
  id               SERIAL PRIMARY KEY,
  tipo             TEXT          NOT NULL DEFAULT 'entrada',
  valor            NUMERIC(12,2) NOT NULL DEFAULT 0,
  descricao        TEXT          DEFAULT '',
  usuario_email    TEXT          DEFAULT '',
  tipo_despesa     TEXT          DEFAULT NULL,
  descricao_outro  TEXT          DEFAULT NULL,
  autorizado_por   TEXT          DEFAULT NULL,
  pedido_id        INTEGER       DEFAULT NULL,
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);

-- Se a tabela já existia com estrutura antiga, adiciona as colunas novas
ALTER TABLE public.movimentacoes_caixa
  ADD COLUMN IF NOT EXISTS tipo_despesa    TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS descricao_outro TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS autorizado_por  TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pedido_id       INTEGER DEFAULT NULL;

-- RLS para a tabela (caso tenha sido criada sem)
ALTER TABLE public.movimentacoes_caixa ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='movimentacoes_caixa' AND policyname='auth_all_caixa') THEN
    CREATE POLICY "auth_all_caixa" ON public.movimentacoes_caixa FOR ALL USING (auth.role() = 'authenticated');
  END IF;
END $$;


-- ── 9.9 perfis_acesso — constraint de cargo ──────────────────────

-- Recria o constraint incluindo 'adminMaster' (se ainda não incluído)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'perfis_acesso_cargo_check'
      AND table_name = 'perfis_acesso'
  ) THEN
    ALTER TABLE public.perfis_acesso DROP CONSTRAINT perfis_acesso_cargo_check;
  END IF;
  ALTER TABLE public.perfis_acesso
    ADD CONSTRAINT perfis_acesso_cargo_check
    CHECK (cargo IN ('adminMaster','dono','gerente','funcionario','garcom'));
END $$;


-- ── 9.10 Índices novos ───────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_caixa_operador
  ON public.movimentacoes_caixa (usuario_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cupons_codigo
  ON public.cupons (codigo);


-- ── 9.11 Realtime (se não foi habilitado antes) ──────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'pedidos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pedidos;
  END IF;
END $$;


-- =================================================================
-- FIM DO MIGRATION
-- =================================================================
-- Após executar, rode as verificações da Seção 8 para confirmar
-- que todas as colunas foram criadas corretamente.
-- =================================================================


-- ═══════════════════════════════════════════════════════════════════
-- SEÇÃO 10 — MIGRATION: QR Alias PY + RPC atomic cupom increment
-- Execute para adicionar novas features sem quebrar o banco existente
-- ═══════════════════════════════════════════════════════════════════

-- 10.1 Coluna QR Code do Alias PY nas configurações
ALTER TABLE configuracoes
  ADD COLUMN IF NOT EXISTS alias_qr_url TEXT DEFAULT '';

-- 10.2 RPC atômica para incrementar uso de cupom (evita race condition)
CREATE OR REPLACE FUNCTION incrementar_uso_cupom(cupom_id INTEGER)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE cupons
  SET usos_realizados = COALESCE(usos_realizados, 0) + 1
  WHERE id = cupom_id;
$$;

GRANT EXECUTE ON FUNCTION incrementar_uso_cupom(INTEGER) TO anon, authenticated;

-- ============================================================
-- MIGRAÇÃO: Web Push Notifications
-- Adiciona coluna para armazenar a subscription do cliente
-- Executar no Supabase > SQL Editor
-- ============================================================
 
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS push_subscription JSONB DEFAULT NULL;
 
-- Índice parcial: só indexa pedidos que têm subscription ativa
-- (útil se a Edge Function precisar fazer lookup por pedido)
CREATE INDEX IF NOT EXISTS idx_pedidos_push_subscription
  ON pedidos ((push_subscription IS NOT NULL))
  WHERE push_subscription IS NOT NULL;
 
-- Comentário descritivo
COMMENT ON COLUMN pedidos.push_subscription IS
  'Web Push PushSubscription JSON (endpoint + keys). Preenchido pelo app do cliente ao autorizar notificações. Limpo automaticamente se retornar HTTP 410 Gone.';

-- ================================================================
-- MIGRAÇÃO: Colunas de confirmação de entrega
-- Erro: PGRST204 "Could not find the 'entrega_confirmada_em' column"
-- Executar no Supabase > SQL Editor
-- ================================================================

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS entrega_confirmada_em  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmacao_tipo        TEXT        DEFAULT NULL;

-- Valores possíveis de confirmacao_tipo:
--   'funcionario' → confirmado pelo admin/motoboy no painel
--   'cliente'     → confirmado pelo próprio cliente no app
--   'massa'       → confirmação em lote (botão "Confirmar todos")
--   'automatico'  → timer de 4h do app.js

COMMENT ON COLUMN pedidos.entrega_confirmada_em IS 'Timestamp de quando a entrega foi confirmada (funcionário, cliente ou automático).';
COMMENT ON COLUMN pedidos.confirmacao_tipo       IS 'Quem confirmou: funcionario | cliente | massa | automatico';

-- ══════════════════════════════════════════════════════════════
--  MIGRAÇÃO v2 — Estatísticas · Ficha Técnica · CRM · Cashback
--  Execute no painel SQL do Supabase (Settings > SQL Editor)
-- ══════════════════════════════════════════════════════════════

-- ── 1. INSUMOS (matérias-primas / ingredientes) ────────────────
CREATE TABLE IF NOT EXISTS insumos (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  unidade       TEXT NOT NULL DEFAULT 'un',   -- un | kg | g | l | ml | pct
  preco_custo   NUMERIC NOT NULL DEFAULT 0,
  estoque_atual NUMERIC DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. FICHAS TÉCNICAS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id             BIGSERIAL PRIMARY KEY,
  produto_id     TEXT,                         -- ref. livre ao id do produto do cardápio
  produto_nome   TEXT NOT NULL,
  markup_percent NUMERIC NOT NULL DEFAULT 300, -- markup em %
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. ITENS DAS FICHAS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ficha_itens (
  id              BIGSERIAL PRIMARY KEY,
  ficha_id        BIGINT REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  insumo_id       BIGINT REFERENCES insumos(id) ON DELETE SET NULL,
  insumo_nome     TEXT,                        -- snapshot do nome (para histórico)
  unidade_insumo  TEXT DEFAULT 'un',
  quantidade      NUMERIC NOT NULL DEFAULT 1
);

-- ── 4. CLIENTES (CRM) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  id               BIGSERIAL PRIMARY KEY,
  nome             TEXT NOT NULL,
  telefone         TEXT UNIQUE NOT NULL,
  data_nascimento  DATE,
  saldo_cashback   NUMERIC DEFAULT 0,
  total_gasto      NUMERIC DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes(telefone);

-- ── 5. TRANSAÇÕES DE CASHBACK ─────────────────────────────────
CREATE TABLE IF NOT EXISTS cashback_transacoes (
  id                BIGSERIAL PRIMARY KEY,
  cliente_id        BIGINT REFERENCES clientes(id) ON DELETE CASCADE,
  cliente_telefone  TEXT,
  pedido_id         BIGINT,
  tipo              TEXT NOT NULL CHECK (tipo IN ('credito','debito')), -- 'credito' | 'debito'
  valor             NUMERIC NOT NULL,
  validade_dias     INT DEFAULT 30,
  expira_em         TIMESTAMPTZ,
  usado             BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashback_cliente ON cashback_transacoes(cliente_id);

-- ── 6. COLUNAS EXTRAS NA TABELA configuracoes ─────────────────
--   Adiciona configurações de cashback (ignore o erro se já existirem)
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cashback_percentual   NUMERIC DEFAULT 10;
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cashback_validade_dias INT    DEFAULT 30;

-- ── 7. RLS (Row Level Security) — Ajuste de Políticas ──────────

ALTER TABLE insumos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ficha_itens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashback_transacoes ENABLE ROW LEVEL SECURITY;

-- Bloco anônimo corrigido para criar políticas apenas se não existirem
DO $$
DECLARE
    tbl TEXT;
    policy_exists BOOLEAN;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['insumos','fichas_tecnicas','ficha_itens','clientes','cashback_transacoes']
    LOOP
        -- Verifica se a política já existe para esta tabela
        SELECT EXISTS (
            SELECT 1 FROM pg_policies 
            WHERE tablename = tbl AND policyname = 'auth_all_access'
        ) INTO policy_exists;

        IF NOT policy_exists THEN
            EXECUTE format(
                'CREATE POLICY "auth_all_access" ON %s FOR ALL TO authenticated USING (true) WITH CHECK (true)',
                tbl
            );
        END IF;
    END LOOP;
END $$;

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS es_bebida BOOLEAN DEFAULT false;

-- ================================================================
--  MIGRACIÓN V2: SISTEMA MULTI-SUCURSAL + CONTRATO LEGAL
--  Proyecto: Sistema de Pedidos / Delivery
--  Ejecutar en: Supabase → SQL Editor
--  ORDEN: ejecutar TODO de una vez (es idempotente / seguro re-ejecutar)
-- ================================================================

CREATE TABLE IF NOT EXISTS filiais (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                TEXT             NOT NULL,
  endereco            TEXT,
  coord_lat           DOUBLE PRECISION NOT NULL,
  coord_lng           DOUBLE PRECISION NOT NULL,
  whatsapp            TEXT             NOT NULL,
  status              TEXT             NOT NULL DEFAULT 'ativa'
                                       CHECK (status IN ('ativa','inativa','manutencao')),
  raio_entrega_km     DOUBLE PRECISION NOT NULL DEFAULT 10.0,
  taxa_entrega_base   NUMERIC(10,2)    DEFAULT 0,
  horario_abertura    TIME             DEFAULT '08:00',
  horario_fechamento  TIME             DEFAULT '22:00',
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filiais_status ON filiais(status);

CREATE TABLE IF NOT EXISTS perfis (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  nome        TEXT,
  role        TEXT        NOT NULL DEFAULT 'funcionario'
                          CHECK (role IN ('adminMaster','gerente','funcionario','motoboy')),
  filial_id   UUID        REFERENCES filiais(id) ON DELETE SET NULL,
  ativo       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfis' AND column_name='role') THEN
    ALTER TABLE perfis ADD COLUMN role TEXT NOT NULL DEFAULT 'funcionario' CHECK (role IN ('adminMaster','gerente','funcionario','motoboy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfis' AND column_name='filial_id') THEN
    ALTER TABLE perfis ADD COLUMN filial_id UUID REFERENCES filiais(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfis' AND column_name='ativo') THEN
    ALTER TABLE perfis ADD COLUMN ativo BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_perfis_usuario_id ON perfis(usuario_id);
CREATE INDEX IF NOT EXISTS idx_perfis_filial_id  ON perfis(filial_id);
CREATE INDEX IF NOT EXISTS idx_perfis_role       ON perfis(role);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pedidos' AND column_name='filial_id') THEN
    ALTER TABLE pedidos ADD COLUMN filial_id UUID REFERENCES filiais(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pedidos_filial_id ON pedidos(filial_id);

CREATE TABLE IF NOT EXISTS contratos_aceites (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  email             TEXT        NOT NULL,
  nome_cliente      TEXT,
  documento_cliente TEXT,
  data_hora         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address        TEXT,
  user_agent        TEXT,
  aceito            BOOLEAN     NOT NULL DEFAULT TRUE,
  versao_contrato   TEXT        NOT NULL DEFAULT 'v1.0-2026',
  hash_contrato     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contratos_usuario_id ON contratos_aceites(usuario_id);
CREATE INDEX IF NOT EXISTS idx_contratos_email       ON contratos_aceites(email);

CREATE OR REPLACE FUNCTION fn_block_delete_contratos() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OPERACIÓN ILEGAL: Los registros de contratos_aceites no pueden eliminarse.'; END; $$;
DROP TRIGGER IF EXISTS trg_block_delete_contratos ON contratos_aceites;
CREATE TRIGGER trg_block_delete_contratos BEFORE DELETE ON contratos_aceites FOR EACH ROW EXECUTE FUNCTION fn_block_delete_contratos();

CREATE OR REPLACE FUNCTION fn_block_update_contratos() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OPERACIÓN ILEGAL: Los registros de contratos_aceites son inmutables.'; END; $$;
DROP TRIGGER IF EXISTS trg_block_update_contratos ON contratos_aceites;
CREATE TRIGGER trg_block_update_contratos BEFORE UPDATE ON contratos_aceites FOR EACH ROW EXECUTE FUNCTION fn_block_update_contratos();

CREATE OR REPLACE FUNCTION get_my_role() RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(role, 'funcionario') FROM perfis WHERE usuario_id = auth.uid() LIMIT 1; $$;

CREATE OR REPLACE FUNCTION get_my_filial_id() RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT filial_id FROM perfis WHERE usuario_id = auth.uid() LIMIT 1; $$;

CREATE OR REPLACE FUNCTION usuario_tem_contrato(p_uid UUID DEFAULT auth.uid()) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM contratos_aceites WHERE usuario_id = p_uid AND aceito = TRUE); $$;

CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_filiais_updated_at ON filiais;
CREATE TRIGGER trg_filiais_updated_at BEFORE UPDATE ON filiais FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE OR REPLACE FUNCTION filial_mais_proxima(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS TABLE (filial_id UUID, nome TEXT, whatsapp TEXT, endereco TEXT, distancia_km DOUBLE PRECISION, raio_entrega_km DOUBLE PRECISION, dentro_do_raio BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT id, nome, whatsapp, endereco,
    (6371.0 * acos(LEAST(1.0, cos(radians(p_lat)) * cos(radians(coord_lat)) * cos(radians(coord_lng) - radians(p_lng)) + sin(radians(p_lat)) * sin(radians(coord_lat))))) AS distancia_km,
    raio_entrega_km,
    (6371.0 * acos(LEAST(1.0, cos(radians(p_lat)) * cos(radians(coord_lat)) * cos(radians(coord_lng) - radians(p_lng)) + sin(radians(p_lat)) * sin(radians(coord_lat))))) <= raio_entrega_km AS dentro_do_raio
  FROM filiais WHERE status = 'ativa' ORDER BY distancia_km ASC LIMIT 1; $$;

-- RLS FILIAIS
ALTER TABLE filiais ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "filiais_select_auth"   ON filiais;
DROP POLICY IF EXISTS "filiais_select_anon"   ON filiais;
DROP POLICY IF EXISTS "filiais_insert_master" ON filiais;
DROP POLICY IF EXISTS "filiais_update_master" ON filiais;
DROP POLICY IF EXISTS "filiais_delete_master" ON filiais;
CREATE POLICY "filiais_select_auth"   ON filiais FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "filiais_select_anon"   ON filiais FOR SELECT TO anon USING (status = 'ativa');
CREATE POLICY "filiais_insert_master" ON filiais FOR INSERT TO authenticated WITH CHECK (get_my_role() = 'adminMaster');
CREATE POLICY "filiais_update_master" ON filiais FOR UPDATE TO authenticated USING (get_my_role() = 'adminMaster');
CREATE POLICY "filiais_delete_master" ON filiais FOR DELETE TO authenticated USING (get_my_role() = 'adminMaster');

-- RLS PERFIS
ALTER TABLE perfis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perfis_select" ON perfis;
DROP POLICY IF EXISTS "perfis_insert" ON perfis;
DROP POLICY IF EXISTS "perfis_update" ON perfis;
CREATE POLICY "perfis_select" ON perfis FOR SELECT TO authenticated USING (usuario_id = auth.uid() OR get_my_role() = 'adminMaster' OR (get_my_role() = 'gerente' AND filial_id = get_my_filial_id()));
CREATE POLICY "perfis_insert" ON perfis FOR INSERT TO authenticated WITH CHECK (usuario_id = auth.uid() OR get_my_role() = 'adminMaster');
CREATE POLICY "perfis_update" ON perfis FOR UPDATE TO authenticated USING (usuario_id = auth.uid() OR get_my_role() = 'adminMaster' OR (get_my_role() = 'gerente' AND filial_id = get_my_filial_id()));

-- RLS PEDIDOS
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pedidos_select_filial" ON pedidos;
DROP POLICY IF EXISTS "pedidos_insert_filial" ON pedidos;
DROP POLICY IF EXISTS "pedidos_update_filial" ON pedidos;
DROP POLICY IF EXISTS "pedidos_insert_anon"   ON pedidos;
CREATE POLICY "pedidos_select_filial" ON pedidos FOR SELECT TO authenticated USING (get_my_role() = 'adminMaster' OR filial_id = get_my_filial_id() OR filial_id IS NULL);
CREATE POLICY "pedidos_insert_anon"   ON pedidos FOR INSERT TO anon, authenticated WITH CHECK (TRUE);
CREATE POLICY "pedidos_update_filial" ON pedidos FOR UPDATE TO authenticated USING (get_my_role() = 'adminMaster' OR filial_id = get_my_filial_id() OR filial_id IS NULL);

-- RLS CONTRATOS
ALTER TABLE contratos_aceites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contratos_select" ON contratos_aceites;
DROP POLICY IF EXISTS "contratos_insert" ON contratos_aceites;
CREATE POLICY "contratos_select" ON contratos_aceites FOR SELECT TO authenticated USING (usuario_id = auth.uid() OR get_my_role() = 'adminMaster');
CREATE POLICY "contratos_insert" ON contratos_aceites FOR INSERT TO authenticated WITH CHECK (usuario_id = auth.uid());

-- ================================================================
--  FIM DA MIGRAÇÃO V2
--  Verificar com: SELECT * FROM filiais; SELECT get_my_role();
-- ================================================================

-- ═══════════════════════════════════════════════════════════════
--  MIGRAÇÃO: MENSALISTAS
--  Execute no SQL Editor do Supabase
-- ═══════════════════════════════════════════════════════════════

-- ── 1. PLANOS MENSALISTAS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planos_mensalistas (
  id                  BIGSERIAL PRIMARY KEY,
  cliente_id          BIGINT REFERENCES clientes(id) ON DELETE CASCADE,
  produto_nome        TEXT NOT NULL,
  quantidade_total    INT NOT NULL DEFAULT 0,
  quantidade_restante INT NOT NULL DEFAULT 0,
  valor_plano         NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ativo               BOOLEAN NOT NULL DEFAULT true,
  data_inicio         DATE,
  data_fim            DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. ENTREGAS DO PLANO ─────────────────────────────────────────
-- Não entra no financeiro: registra apenas consumo do saldo do plano
CREATE TABLE IF NOT EXISTS mensalista_entregas (
  id           BIGSERIAL PRIMARY KEY,
  plano_id     BIGINT REFERENCES planos_mensalistas(id) ON DELETE CASCADE,
  cliente_id   BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
  produto_nome TEXT,
  quantidade   INT NOT NULL DEFAULT 1,
  observacoes  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. ÍNDICES ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_planos_mensalistas_cliente ON planos_mensalistas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_planos_mensalistas_ativo   ON planos_mensalistas(ativo);
CREATE INDEX IF NOT EXISTS idx_mensalista_entregas_plano  ON mensalista_entregas(plano_id);
CREATE INDEX IF NOT EXISTS idx_mensalista_entregas_data   ON mensalista_entregas(created_at);

-- ── 4. ROW LEVEL SECURITY ─────────────────────────────────────────
ALTER TABLE planos_mensalistas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensalista_entregas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated planos"   ON planos_mensalistas;
DROP POLICY IF EXISTS "Authenticated entregas" ON mensalista_entregas;

CREATE POLICY "Authenticated planos"
  ON planos_mensalistas FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated entregas"
  ON mensalista_entregas FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ── 5. VERIFICAR TABELA clientes (cria se não existir) ────────────
-- Se a tabela clientes ainda não existir no seu projeto, descomente:
/*
CREATE TABLE IF NOT EXISTS clientes (
  id              BIGSERIAL PRIMARY KEY,
  nome            TEXT NOT NULL,
  telefone        TEXT,
  data_nascimento DATE,
  saldo_cashback  NUMERIC(12, 2) DEFAULT 0,
  total_gasto     NUMERIC(12, 2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
*/

-- Tabela de sessões de caixa
CREATE TABLE sessoes_caixa (
  id              BIGSERIAL PRIMARY KEY,
  usuario_email   TEXT        NOT NULL,
  usuario_nome    TEXT,
  aberto_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fechado_em      TIMESTAMPTZ,          -- NULL = sessão ainda aberta
  valor_abertura  NUMERIC     DEFAULT 0,
  valor_fechamento NUMERIC,
  observacao      TEXT
);

-- Índices para performance
CREATE INDEX idx_sessoes_usuario ON sessoes_caixa (usuario_email);
CREATE INDEX idx_sessoes_aberto  ON sessoes_caixa (aberto_em);

-- Adiciona sessao_id nas movimentações (liga cada movimentação à sessão)
ALTER TABLE movimentacoes_caixa
  ADD COLUMN IF NOT EXISTS sessao_id BIGINT REFERENCES sessoes_caixa(id);

-- RLS: funcionário só vê a própria sessão
ALTER TABLE sessoes_caixa ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gestor_ve_tudo" ON sessoes_caixa
  FOR ALL USING (true);  -- controle feito no JS por perfil

  -- ══════════════════════════════════════════════════════════════
--  MIGRAÇÃO — Suporte a Variações de Produto (Varejo)
--  Execute no SQL Editor do Supabase (Settings › SQL Editor)
--  Compatível com o schema existente da tabela "produtos".
-- ══════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
--  1. TABELA produto_variacoes
--     Uma linha por combinação vendável de um produto.
--     Ex: Camiseta Azul P, Camiseta Azul M, Pod Melancia 20mg …
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS produto_variacoes (
  id               BIGSERIAL PRIMARY KEY,
  produto_id       BIGINT      NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,

  -- O que identifica esta variação para o cliente
  nome             TEXT        NOT NULL,          -- "Azul - M", "110v", "Melancia"
  sku              TEXT,                          -- código interno / cód. barras
  
  -- Preço: pode ser sobrepreço (+Gs 5000) ou preço fixo absoluto.
  -- Use preco_absoluto = TRUE para substituir o preço base do produto.
  preco_adicional  NUMERIC(14,2) NOT NULL DEFAULT 0,
  preco_absoluto   BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Controle de estoque
  estoque_qtd      INT         NOT NULL DEFAULT 0  CHECK (estoque_qtd >= 0),
  controlar_estoque BOOLEAN    NOT NULL DEFAULT TRUE,  -- FALSE = estoque infinito

  -- Metadados
  ativo            BOOLEAN     NOT NULL DEFAULT TRUE,
  ordem            SMALLINT    NOT NULL DEFAULT 0,    -- ordem de exibição
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice principal: buscar todas as variações de um produto
CREATE INDEX IF NOT EXISTS idx_pv_produto_id
  ON produto_variacoes (produto_id, ordem);

-- Índice de SKU (útil para busca por código de barras no PDV)
CREATE INDEX IF NOT EXISTS idx_pv_sku
  ON produto_variacoes (sku)
  WHERE sku IS NOT NULL;

-- Trigger: atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pv_updated_at ON produto_variacoes;
CREATE TRIGGER trg_pv_updated_at
  BEFORE UPDATE ON produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();


-- ──────────────────────────────────────────────────────────────
--  2. COLUNA tem_variacoes NA TABELA produtos
--     Flag que o app lê para decidir se exibe "Comprar" ou "Ver Opções".
--     Mantida sincronizada pelo trigger abaixo — não edite manualmente.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS tem_variacoes BOOLEAN NOT NULL DEFAULT FALSE;


-- Trigger: sincroniza tem_variacoes sempre que produto_variacoes muda
CREATE OR REPLACE FUNCTION _sync_tem_variacoes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  _pid BIGINT;
  _tem BOOLEAN;
BEGIN
  -- Determina o produto_id afetado (INSERT, UPDATE, DELETE)
  IF TG_OP = 'DELETE' THEN
    _pid := OLD.produto_id;
  ELSE
    _pid := NEW.produto_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM produto_variacoes
    WHERE produto_id = _pid AND ativo = TRUE
  ) INTO _tem;

  UPDATE produtos SET tem_variacoes = _tem WHERE id = _pid;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_variacoes ON produto_variacoes;
CREATE TRIGGER trg_sync_variacoes
  AFTER INSERT OR UPDATE OR DELETE ON produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _sync_tem_variacoes();


-- ──────────────────────────────────────────────────────────────
--  3. FUNÇÃO DE DECREMENTO DE ESTOQUE
--     Chamada pelo backend/edge-function ao confirmar pedido,
--     ou diretamente via RPC do app.js após criação do pedido.
--     Usa FOR UPDATE para evitar race condition em alto volume.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION decrementar_estoque_variacao(
  p_variacao_id BIGINT,
  p_quantidade  INT DEFAULT 1
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _atual INT;
  _controlar BOOLEAN;
  _result JSON;
BEGIN
  -- Lock na linha específica
  SELECT estoque_qtd, controlar_estoque
  INTO _atual, _controlar
  FROM produto_variacoes
  WHERE id = p_variacao_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Variação não encontrada');
  END IF;

  -- Se não controla estoque, só confirma sem decrementar
  IF NOT _controlar THEN
    RETURN json_build_object('ok', true, 'estoque_restante', NULL);
  END IF;

  IF _atual < p_quantidade THEN
    RETURN json_build_object('ok', false, 'erro', 'Estoque insuficiente', 'disponivel', _atual);
  END IF;

  UPDATE produto_variacoes
  SET estoque_qtd = estoque_qtd - p_quantidade
  WHERE id = p_variacao_id;

  RETURN json_build_object('ok', true, 'estoque_restante', _atual - p_quantidade);
END;
$$;


-- ──────────────────────────────────────────────────────────────
--  4. VIEW AUXILIAR: produtos_com_estoque
--     Usada no painel admin para ver rapidamente quais variações
--     estão acabando (estoque <= 5).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW produtos_com_estoque AS
SELECT
  p.id          AS produto_id,
  p.nome        AS produto_nome,
  p.categoria_slug,
  pv.id         AS variacao_id,
  pv.nome       AS variacao_nome,
  pv.sku,
  pv.estoque_qtd,
  pv.controlar_estoque,
  pv.preco_adicional,
  pv.preco_absoluto,
  pv.ativo
FROM produto_variacoes pv
JOIN produtos p ON p.id = pv.produto_id
ORDER BY p.nome, pv.ordem, pv.nome;


-- ──────────────────────────────────────────────────────────────
--  5. RLS (Row Level Security) — opcional mas recomendado
--     Permite leitura pública das variações ativas
--     e escrita apenas para usuários autenticados (admin).
-- ──────────────────────────────────────────────────────────────
ALTER TABLE produto_variacoes ENABLE ROW LEVEL SECURITY;

-- Leitura pública: qualquer visitante vê variações ativas
DROP POLICY IF EXISTS pv_select_public ON produto_variacoes;
CREATE POLICY pv_select_public ON produto_variacoes
  FOR SELECT USING (ativo = TRUE);

-- Escrita: somente usuários autenticados (lojistas)
DROP POLICY IF EXISTS pv_write_auth ON produto_variacoes;
CREATE POLICY pv_write_auth ON produto_variacoes
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ──────────────────────────────────────────────────────────────
--  6. DADOS DE EXEMPLO — remova após testar
--     Demonstra os três segmentos mencionados: Roupas, Pods, Eletrônicos
-- ──────────────────────────────────────────────────────────────

/*
-- Roupas: produto_id = 101 (camiseta básica)
INSERT INTO produto_variacoes (produto_id, nome, sku, estoque_qtd) VALUES
  (101, 'Branco - P',  'CAM-BC-P',  12),
  (101, 'Branco - M',  'CAM-BC-M',  8),
  (101, 'Branco - G',  'CAM-BC-G',  5),
  (101, 'Preto - P',   'CAM-PT-P',  10),
  (101, 'Preto - M',   'CAM-PT-M',  0),   -- esgotado
  (101, 'Preto - G',   'CAM-PT-G',  3);

-- Eletrônicos: produto_id = 202 (carregador)
INSERT INTO produto_variacoes (produto_id, nome, sku, estoque_qtd, preco_adicional) VALUES
  (202, '110v',  'CAR-110', 20, 0),
  (202, '220v',  'CAR-220', 15, 0),
  (202, 'Bivolt','CAR-BIV', 7, 15000);   -- + Gs 15.000 pelo bivolt

-- Pods: produto_id = 303 (pod descartável 20mg)
INSERT INTO produto_variacoes (produto_id, nome, sku, estoque_qtd) VALUES
  (303, 'Melancia',       'POD-MEL', 30),
  (303, 'Menta',          'POD-MNT', 25),
  (303, 'Morango Gelado', 'POD-MRG', 18),
  (303, 'Uva',            'POD-UVA', 5);
*/


-- ──────────────────────────────────────────────────────────────
--  FIM DA MIGRAÇÃO
-- ──────────────────────────────────────────────────────────────
COMMENT ON TABLE produto_variacoes IS
  'Variações de produto para e-commerce varejo (tamanho, cor, sabor, voltagem…). '
  'Cada linha representa uma SKU vendável com controle de estoque independente.';