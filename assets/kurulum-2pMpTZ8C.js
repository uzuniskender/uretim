const d=`-- 0001 · SISTEM TEMELI
--
-- Iki sema:
--   sistem   — urunun kendi altyapisi: olay defteri, kural sozlugu, alan katalogu, gorunum, tema.
--              Is kolunu BILMEZ.
--   cekirdek — evrensel uretim varliklari: kalem, rota, belge, stok hareketi...
--              Is kolunu BILMEZ ("boya", "aski", "Rapido" burada gecmez — ilke 11).
--
-- Firmaya ozel her sey (kod sablonu, kardes eki, acik alanlar) KAYITTIR, kod degil.

CREATE SCHEMA IF NOT EXISTS sistem;
CREATE SCHEMA IF NOT EXISTS cekirdek;

-- Uygulanan sema surumleri. Uygulayici (src/uygula.js) yazar; checksum degisirse DURUR.
CREATE TABLE IF NOT EXISTS sistem.sema_surum (
  surum       text PRIMARY KEY,
  checksum    text NOT NULL,
  uygulandi   timestamptz NOT NULL DEFAULT now()
);

-- Firma kimligi: her veritabaninda TEK satir (firma basina ayri veritabani kararı).
CREATE TABLE sistem.firma (
  tek          boolean PRIMARY KEY DEFAULT true CHECK (tek),
  ad           text NOT NULL,
  kisa_ad      text,
  para_birimi  text NOT NULL DEFAULT 'TRY' CHECK (para_birimi ~ '^[A-Z]{3}$'),
  dil          text NOT NULL DEFAULT 'tr',
  saat_dilimi  text NOT NULL DEFAULT 'Europe/Istanbul',
  olusturma    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- ISLEM BAGLAMI
-- Her yazma "kim, hangi kaynaktan, hangi toplu islemin parcasi olarak, neden" bilgisini
-- tasir. Olay defteri bunu buradan okur. Uc katman, sirayla:
--   1) set_config('uretim.<anahtar>', ..., true)  — islem icinde (sunucu fonksiyonlari, testler)
--   2) PostgREST istek basligi  x-uretim-<anahtar> — ekrandan gelen yazma
--   3) Supabase auth.uid()                          — yalniz 'kullanici' icin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.baglam(p_anahtar text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text;
  v_basliklar jsonb;
BEGIN
  v := NULLIF(current_setting('uretim.' || p_anahtar, true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;

  BEGIN
    v_basliklar := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_basliklar := NULL;
  END;
  v := NULLIF(v_basliklar ->> ('x-uretim-' || replace(p_anahtar, '_', '-')), '');
  IF v IS NOT NULL THEN RETURN v; END IF;

  IF p_anahtar = 'kullanici' AND to_regprocedure('auth.uid()') IS NOT NULL THEN
    EXECUTE 'SELECT auth.uid()::text' INTO v;
  END IF;
  RETURN v;
END $$;

-- Islem baglamini kurar ve islem grubunu dondurur. Grup verilmezse yenisi uretilir.
-- Toplu bir islem (Excel ice aktarim, kural uygulamasi) TEK grup altinda yazilir ve
-- sistem.islem_geri_al(grup) ile tek hamlede geri alinir.
--
-- p_oturum_boyu:
--   false (varsayilan) — baglam YALNIZ bu islem (transaction) icinde gecerli. Uretimde dogru olan budur:
--                        havuzlanmis bir baglantida onceki istegin "kim"i sonrakine sizamaz.
--   true               — baglanti kapanana kadar gecerli. YALNIZ tek kullanicili adanmis baglantilar icin
--                        (testler, kurulum betigi). Havuzlu sunucuda kullanmak yanlis kisiye yazar.
CREATE OR REPLACE FUNCTION sistem.baglam_kur(
  p_kaynak      text,
  p_kullanici   text DEFAULT NULL,
  p_kaynak_ref  text DEFAULT NULL,
  p_gerekce     text DEFAULT NULL,
  p_islem_grubu uuid DEFAULT NULL,
  p_oturum_boyu boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_grup  uuid := COALESCE(p_islem_grubu, gen_random_uuid());
  v_yerel boolean := NOT p_oturum_boyu;
BEGIN
  PERFORM set_config('uretim.kaynak',      p_kaynak, v_yerel);
  PERFORM set_config('uretim.kullanici',   COALESCE(p_kullanici, ''), v_yerel);
  PERFORM set_config('uretim.kaynak_ref',  COALESCE(p_kaynak_ref, ''), v_yerel);
  PERFORM set_config('uretim.gerekce',     COALESCE(p_gerekce, ''), v_yerel);
  PERFORM set_config('uretim.islem_grubu', v_grup::text, v_yerel);
  RETURN v_grup;
END $$;

-- Ortak damga: guncelleme kolonu elle yazilmaz.
CREATE OR REPLACE FUNCTION sistem.guncelleme_damgala()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.guncelleme := clock_timestamp();
  RETURN NEW;
END $$;
`,m=`-- 0002 · OLAY DEFTERI (ilke 2: degisen her sey defterde)
--
-- Eski UYS'de 23 ayri log/gecmis tablosu vardi, her biri farkli kolonlarla; "bu deger ne zaman,
-- kimin yuzunden degisti" tek sorguyla cevaplanamiyordu. Burada TEK defter, TEK bicim.
--
-- Kurallar:
--   * Defter yalniz EKLENIR. Guncelleme ve silme trigger ile reddedilir.
--   * UPDATE alan bazinda yazilir: 2 alan degistiyse 2 satir. "Sadece 'guncelleme' degisti"
--     gibi gurultu yazilmaz.
--   * Her satir bir islem grubuna aittir -> toplu islem tek hamlede geri alinir.
--   * Geri alma SONRAKI degisiklikleri ezmez: kayit o arada baskasinca degistiyse durur.

CREATE TABLE sistem.olay (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zaman         timestamptz NOT NULL DEFAULT clock_timestamp(),
  islem_id      bigint NOT NULL DEFAULT txid_current(),
  islem_grubu   uuid,
  kullanici     text,
  kaynak        text NOT NULL CHECK (kaynak IN ('ekran','ice_aktarim','kural','api','sistem','geri_al','kurulum','test')),
  kaynak_ref    text,
  gerekce       text,
  varlik        text NOT NULL,              -- 'cekirdek.kalem'
  anahtar_alan  text NOT NULL,              -- 'id'
  kayit_id      text NOT NULL,
  islem         text NOT NULL CHECK (islem IN ('ekle','degistir','sil')),
  alan          text,                        -- yalniz 'degistir' icin
  eski          jsonb,
  yeni          jsonb,
  CHECK ((islem = 'degistir') = (alan IS NOT NULL))
);
CREATE INDEX olay_kayit_idx ON sistem.olay (varlik, kayit_id, id);
CREATE INDEX olay_grup_idx  ON sistem.olay (islem_grubu) WHERE islem_grubu IS NOT NULL;
CREATE INDEX olay_zaman_idx ON sistem.olay (zaman);

CREATE OR REPLACE FUNCTION sistem.olay_degistirilemez()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Olay defteri yalniz eklenir: % yapilamaz. Duzeltme icin sistem.islem_geri_al kullanin.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER olay_kilit
BEFORE UPDATE OR DELETE ON sistem.olay
FOR EACH ROW EXECUTE FUNCTION sistem.olay_degistirilemez();

-- Defterde izlenmeyen kolonlar: deger degil damga.
CREATE OR REPLACE FUNCTION sistem.olay_yok_sayilan_alan(p_alan text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_alan IN ('guncelleme', 'olusturma')
$$;

-- Genel izleyici. TG_ARGV[0] = anahtar kolonu (varsayilan 'id').
CREATE OR REPLACE FUNCTION sistem.olay_izle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_anahtar  text := COALESCE(TG_ARGV[0], 'id');
  v_varlik   text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_eski     jsonb;
  v_yeni     jsonb;
  v_kayit    text;
  v_alan     text;
  v_kaynak   text := COALESCE(sistem.baglam('kaynak'), 'sistem');
  v_grup     uuid := NULLIF(sistem.baglam('islem_grubu'), '')::uuid;
  v_kull     text := sistem.baglam('kullanici');
  v_ref      text := sistem.baglam('kaynak_ref');
  v_gerekce  text := sistem.baglam('gerekce');
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_eski := to_jsonb(OLD); END IF;
  IF TG_OP IN ('UPDATE','INSERT') THEN v_yeni := to_jsonb(NEW); END IF;
  v_kayit := COALESCE(v_yeni, v_eski) ->> v_anahtar;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO sistem.olay (islem_grubu, kullanici, kaynak, kaynak_ref, gerekce, varlik, anahtar_alan, kayit_id, islem, yeni)
    VALUES (v_grup, v_kull, v_kaynak, v_ref, v_gerekce, v_varlik, v_anahtar, v_kayit, 'ekle', v_yeni);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO sistem.olay (islem_grubu, kullanici, kaynak, kaynak_ref, gerekce, varlik, anahtar_alan, kayit_id, islem, eski)
    VALUES (v_grup, v_kull, v_kaynak, v_ref, v_gerekce, v_varlik, v_anahtar, v_kayit, 'sil', v_eski);
    RETURN OLD;
  END IF;

  FOR v_alan IN SELECT jsonb_object_keys(v_yeni) LOOP
    CONTINUE WHEN sistem.olay_yok_sayilan_alan(v_alan);
    CONTINUE WHEN (v_eski -> v_alan) IS NOT DISTINCT FROM (v_yeni -> v_alan);
    INSERT INTO sistem.olay (islem_grubu, kullanici, kaynak, kaynak_ref, gerekce, varlik, anahtar_alan, kayit_id, islem, alan, eski, yeni)
    VALUES (v_grup, v_kull, v_kaynak, v_ref, v_gerekce, v_varlik, v_anahtar, v_kayit, 'degistir', v_alan, v_eski -> v_alan, v_yeni -> v_alan);
  END LOOP;
  RETURN NEW;
END $$;

-- Bir tabloyu deftere baglar. Yeni tablo acan HER migration bunu cagirir;
-- tests/yapi.test.js cagrilmayan tabloyu yakalar (kural ancak denetlenirse kuraldir).
CREATE OR REPLACE FUNCTION sistem.olay_izlemeye_al(p_tablo regclass, p_anahtar text DEFAULT 'id')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS zz_olay_izle ON %s', p_tablo);
  -- 'zz_' oneki: AFTER trigger'lar ada gore sirali calisir; defter EN SON yazar.
  EXECUTE format(
    'CREATE TRIGGER zz_olay_izle AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION sistem.olay_izle(%L)',
    p_tablo, p_anahtar);
END $$;

-- ---------------------------------------------------------------------------
-- GERI AL: bir islem grubunu ters sirayla geri oynatir.
-- Guvenlik: her adimda kaydin SIMDIKI degeri, defterdeki 'yeni' degerle ayni olmali.
-- Degilse o kayit bu gruptan sonra degistirilmistir -> hicbir sey yapilmaz, hata verilir
-- (p_zorla ile gecilebilir). Geri alma da defterde yeni bir grup olarak durur.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.islem_geri_al(p_grup uuid, p_gerekce text DEFAULT NULL, p_zorla boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  o        sistem.olay%ROWTYPE;
  v_yeni_grup uuid;
  v_simdiki jsonb;
  v_sayi   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sistem.olay WHERE islem_grubu = p_grup) THEN
    RAISE EXCEPTION 'Islem grubu bulunamadi: %', p_grup;
  END IF;

  v_yeni_grup := sistem.baglam_kur('geri_al', sistem.baglam('kullanici'), p_grup::text,
                                   COALESCE(p_gerekce, 'islem grubu geri alindi'));

  FOR o IN SELECT * FROM sistem.olay WHERE islem_grubu = p_grup ORDER BY id DESC LOOP
    EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %I::text = $1', o.varlik, o.anahtar_alan)
      INTO v_simdiki USING o.kayit_id;

    IF o.islem = 'ekle' THEN
      IF v_simdiki IS NULL THEN CONTINUE; END IF;
      EXECUTE format('DELETE FROM %s WHERE %I::text = $1', o.varlik, o.anahtar_alan) USING o.kayit_id;

    ELSIF o.islem = 'sil' THEN
      IF v_simdiki IS NOT NULL AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% silindikten sonra yeniden olusturulmus.', o.varlik, o.kayit_id;
      END IF;
      EXECUTE format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, $1)', o.varlik) USING o.eski;

    ELSE -- degistir
      IF v_simdiki IS NULL THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% artik yok.', o.varlik, o.kayit_id;
      END IF;
      IF (v_simdiki -> o.alan) IS DISTINCT FROM o.yeni AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/%.% bu islemden sonra degistirilmis (simdi %, islem %).',
          o.varlik, o.kayit_id, o.alan, v_simdiki -> o.alan, o.yeni;
      END IF;
      EXECUTE format(
        'UPDATE %1$s SET %2$I = (jsonb_populate_record(NULL::%1$s, $1)).%2$I WHERE %3$I::text = $2',
        o.varlik, o.alan, o.anahtar_alan)
        USING jsonb_build_object(o.alan, o.eski), o.kayit_id;
    END IF;
    v_sayi := v_sayi + 1;
  END LOOP;

  RETURN v_yeni_grup;
END $$;

-- ZAMANDA GERI GIT: bir kaydin verilen andaki hali (defterden yeniden kurulur).
-- Kayit o anda yoksa NULL.
CREATE OR REPLACE FUNCTION sistem.kayit_zamaninda(p_tablo regclass, p_kayit_id text, p_zaman timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_varlik text;
  o        sistem.olay%ROWTYPE;
  v_durum  jsonb := NULL;
BEGIN
  SELECT n.nspname || '.' || c.relname INTO v_varlik
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_tablo;

  FOR o IN SELECT * FROM sistem.olay
           WHERE varlik = v_varlik AND kayit_id = p_kayit_id AND zaman <= p_zaman
           ORDER BY id LOOP
    IF o.islem = 'ekle' THEN v_durum := o.yeni;
    ELSIF o.islem = 'sil' THEN v_durum := NULL;
    ELSE v_durum := jsonb_set(COALESCE(v_durum, '{}'::jsonb), ARRAY[o.alan], COALESCE(o.yeni, 'null'::jsonb), true);
    END IF;
  END LOOP;
  RETURN v_durum;
END $$;

-- Bir kaydin tarihcesi, okunur bicimde.
CREATE OR REPLACE VIEW sistem.olay_okunur AS
SELECT id, zaman, kullanici, kaynak, kaynak_ref, gerekce, islem_grubu,
       varlik, kayit_id, islem, alan,
       CASE islem WHEN 'degistir' THEN eski ELSE NULL END AS eski_deger,
       CASE islem WHEN 'degistir' THEN yeni ELSE NULL END AS yeni_deger
FROM sistem.olay;
`,o=`-- 0003 · KURAL SOZLUGU (ilke 3: kural kod degil, kayittir)
--
-- Eski UYS'de "sonu 2,4,5,6 kardes" kurali bir METINdi ve kodda 36 ayri kopyasi vardi
-- (20 yerde left(kod,8), 16 yerde right(kod,1)). Ne insan ne yapay zeka tek yerden okuyabiliyordu.
--
-- Burada:
--   * Her kural makinenin okudugu TEK satir: tanim (jsonb) + aciklama + ORNEKLER.
--   * Ornekler ayni zamanda testtir. Ornegi gecmeyen kural 'aktif' olamaz (trigger reddeder).
--   * Kod kurali kopyalamaz; sistem.kural_calistir / sistem.kod_coz / sistem.kardes_mi cagirir.
--   * Firmaya ozel deger (Ozler'in 9 hanesi) cekirdekte DEGIL, firma paketinde (firma/<ad>/).
--
-- Kural turleri ve tanim bicimleri:
--   kod_sablonu : {"desenler":[{"ad":"mamul","desen":"^([0-9]{8})([0-9])(?:-([A-Z]+))?$",
--                               "gruplar":["kok","varyant","ek"]}, ...]}
--                 Desenler sirayla denenir; ilk eslesen kazanir.
--   kardes      : {"kod_sablonu":"K-KOD-SABLON","ayni":["kok"],"ayirt":"varyant",
--                  "gecerli":["2","4","5","6"], "anlam":{"2":"...", ...}}
--   (yeni turler yeni migration ile eklenir; bilinmeyen tur calistirilamaz)

CREATE TABLE sistem.kural (
  kod          text PRIMARY KEY CHECK (kod ~ '^K-[A-Z0-9]+(-[A-Z0-9]+)*$'),
  ad           text NOT NULL,
  tur          text NOT NULL CHECK (tur IN ('kod_sablonu','kardes')),
  varlik       text NOT NULL,
  tanim        jsonb NOT NULL CHECK (jsonb_typeof(tanim) = 'object'),
  aciklama     text NOT NULL CHECK (length(aciklama) >= 10),
  ornekler     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(ornekler) = 'array'),
  durum        text NOT NULL DEFAULT 'taslak' CHECK (durum IN ('taslak','aktif','emekli')),
  kaynak       text,          -- "Serdar, 14 Eyl 2026" gibi: kararin sahibi
  olusturma    timestamptz NOT NULL DEFAULT now(),
  guncelleme   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER a_guncelleme BEFORE UPDATE ON sistem.kural
FOR EACH ROW EXECUTE FUNCTION sistem.guncelleme_damgala();
SELECT sistem.olay_izlemeye_al('sistem.kural', 'kod');

-- ---------------------------------------------------------------------------
-- KOD SABLONU MOTORU
-- ---------------------------------------------------------------------------
-- Bir kodu belirli bir sablon kuralina gore parcalar.
-- Donus: {"sablon":"mamul","kok":"10190200","varyant":"5","ek":null} ya da eslesmezse NULL.
CREATE OR REPLACE FUNCTION sistem.kod_coz_kural(p_kural_tanim jsonb, p_kod text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  d       jsonb;
  m       text[];
  v_sonuc jsonb;
  i       int;
BEGIN
  IF p_kod IS NULL THEN RETURN NULL; END IF;
  FOR d IN SELECT * FROM jsonb_array_elements(p_kural_tanim -> 'desenler') LOOP
    m := regexp_match(p_kod, d ->> 'desen');
    CONTINUE WHEN m IS NULL;
    v_sonuc := jsonb_build_object('sablon', d ->> 'ad');
    FOR i IN 1 .. jsonb_array_length(d -> 'gruplar') LOOP
      v_sonuc := v_sonuc || jsonb_build_object((d -> 'gruplar') ->> (i - 1), m[i]);
    END LOOP;
    RETURN v_sonuc;
  END LOOP;
  RETURN NULL;
END $$;

-- Aktif kod sablonuyla coz. Birden fazla aktif sablon varsa kod verilmelidir.
CREATE OR REPLACE FUNCTION sistem.kod_coz(p_kod text, p_kural text DEFAULT 'K-KOD-SABLON')
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v_tanim jsonb;
BEGIN
  SELECT tanim INTO v_tanim FROM sistem.kural WHERE kod = p_kural AND tur = 'kod_sablonu' AND durum <> 'emekli';
  IF v_tanim IS NULL THEN
    RAISE EXCEPTION 'Kod sablonu kurali yok: %. Kurulumda sistem.kural tablosuna eklenmeli.', p_kural;
  END IF;
  RETURN sistem.kod_coz_kural(v_tanim, p_kod);
END $$;

-- ---------------------------------------------------------------------------
-- KARDES MOTORU
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.kardes_mi_kural(p_tanim jsonb, p_sablon_tanim jsonb, p_a text, p_b text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  a jsonb := sistem.kod_coz_kural(p_sablon_tanim, p_a);
  b jsonb := sistem.kod_coz_kural(p_sablon_tanim, p_b);
  v_alan  text;
  v_ayirt text := p_tanim ->> 'ayirt';
BEGIN
  IF a IS NULL OR b IS NULL OR p_a = p_b THEN RETURN false; END IF;
  FOR v_alan IN SELECT jsonb_array_elements_text(p_tanim -> 'ayni') LOOP
    IF (a ->> v_alan) IS DISTINCT FROM (b ->> v_alan) THEN RETURN false; END IF;
  END LOOP;
  IF (a ->> v_ayirt) IS NULL OR (b ->> v_ayirt) IS NULL THEN RETURN false; END IF;
  IF p_tanim ? 'gecerli' THEN
    IF NOT (p_tanim -> 'gecerli') ? (a ->> v_ayirt) OR NOT (p_tanim -> 'gecerli') ? (b ->> v_ayirt) THEN
      RETURN false;
    END IF;
  END IF;
  RETURN (a ->> v_ayirt) <> (b ->> v_ayirt);
END $$;

CREATE OR REPLACE FUNCTION sistem.kardes_mi(p_a text, p_b text, p_kural text DEFAULT 'K-KOD-KARDES')
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tanim jsonb;
  v_sablon jsonb;
BEGIN
  SELECT tanim INTO v_tanim FROM sistem.kural WHERE kod = p_kural AND tur = 'kardes' AND durum <> 'emekli';
  IF v_tanim IS NULL THEN RAISE EXCEPTION 'Kardes kurali yok: %', p_kural; END IF;
  SELECT tanim INTO v_sablon FROM sistem.kural WHERE kod = v_tanim ->> 'kod_sablonu';
  IF v_sablon IS NULL THEN RAISE EXCEPTION 'Kardes kurali % icin kod sablonu yok: %', p_kural, v_tanim ->> 'kod_sablonu'; END IF;
  RETURN sistem.kardes_mi_kural(v_tanim, v_sablon, p_a, p_b);
END $$;

-- ---------------------------------------------------------------------------
-- TEK CALISTIRICI: ornek testleri ve dis cagiranlar bunu kullanir.
-- Girdi bicimi turune gore:
--   kod_sablonu : {"kod":"101902005"}                    -> cozum jsonb
--   kardes      : {"a":"101902002","b":"101902005"}      -> true/false
-- p_tanim verilirse tablodaki yerine o kullanilir (kaydedilmeden once test icin).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.kural_calistir(p_kod text, p_girdi jsonb, p_tanim jsonb DEFAULT NULL, p_tur text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tur   text := p_tur;
  v_tanim jsonb := p_tanim;
  v_sablon jsonb;
BEGIN
  IF v_tanim IS NULL OR v_tur IS NULL THEN
    SELECT tur, tanim INTO v_tur, v_tanim FROM sistem.kural WHERE kod = p_kod;
    IF v_tur IS NULL THEN RAISE EXCEPTION 'Kural yok: %', p_kod; END IF;
  END IF;

  IF v_tur = 'kod_sablonu' THEN
    RETURN COALESCE(sistem.kod_coz_kural(v_tanim, p_girdi ->> 'kod'), 'null'::jsonb);
  ELSIF v_tur = 'kardes' THEN
    SELECT tanim INTO v_sablon FROM sistem.kural WHERE kod = v_tanim ->> 'kod_sablonu';
    IF v_sablon IS NULL THEN RAISE EXCEPTION 'Kardes kurali % icin kod sablonu yok: %', p_kod, v_tanim ->> 'kod_sablonu'; END IF;
    RETURN to_jsonb(sistem.kardes_mi_kural(v_tanim, v_sablon, p_girdi ->> 'a', p_girdi ->> 'b'));
  END IF;
  RAISE EXCEPTION 'Calistirilamayan kural turu: %', v_tur;
END $$;

-- Orneklerin hepsini kosar. p_kod NULL ise tum aktif/taslak kurallar.
CREATE OR REPLACE FUNCTION sistem.kural_test(p_kod text DEFAULT NULL)
RETURNS TABLE(kod text, sira int, girdi jsonb, beklenen jsonb, gercek jsonb, gecti boolean, not_ text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  k sistem.kural%ROWTYPE;
  o jsonb;
  i int;
BEGIN
  FOR k IN SELECT * FROM sistem.kural r WHERE (p_kod IS NULL OR r.kod = p_kod) AND r.durum <> 'emekli' ORDER BY r.kod LOOP
    i := 0;
    FOR o IN SELECT * FROM jsonb_array_elements(k.ornekler) LOOP
      i := i + 1;
      kod := k.kod; sira := i; girdi := o -> 'girdi'; beklenen := o -> 'beklenen'; not_ := o ->> 'not';
      gercek := sistem.kural_calistir(k.kod, o -> 'girdi', k.tanim, k.tur);
      gecti := gercek IS NOT DISTINCT FROM beklenen;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END $$;

-- KAPI: aktif kural ornegi olmadan ya da ornegi gecmeden kaydedilemez.
CREATE OR REPLACE FUNCTION sistem.kural_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb;
  v_gercek jsonb;
  i int := 0;
BEGIN
  IF NEW.durum <> 'aktif' THEN RETURN NEW; END IF;
  IF jsonb_array_length(NEW.ornekler) < 2 THEN
    RAISE EXCEPTION 'Kural % aktif olamaz: en az 2 ornek (biri olumlu, biri olumsuz) gerekir.', NEW.kod
      USING ERRCODE = 'check_violation';
  END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(NEW.ornekler) LOOP
    i := i + 1;
    IF NOT (o ? 'girdi' AND o ? 'beklenen') THEN
      RAISE EXCEPTION 'Kural % ornek %: "girdi" ve "beklenen" zorunlu.', NEW.kod, i USING ERRCODE = 'check_violation';
    END IF;
    v_gercek := sistem.kural_calistir(NEW.kod, o -> 'girdi', NEW.tanim, NEW.tur);
    IF v_gercek IS DISTINCT FROM (o -> 'beklenen') THEN
      RAISE EXCEPTION 'Kural % aktif olamaz: ornek % gecmedi. Girdi %, beklenen %, cikan %.',
        NEW.kod, i, o -> 'girdi', o -> 'beklenen', v_gercek USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER b_kural_kapisi BEFORE INSERT OR UPDATE ON sistem.kural
FOR EACH ROW EXECUTE FUNCTION sistem.kural_kapisi();

-- OKUMA KAPISI: insan ve yapay zeka icin tek bakis.
-- 'kullanan' otomatik cikar: kural kodunu metninde geciren fonksiyon ve view'ler.
CREATE OR REPLACE VIEW sistem.kural_ozeti AS
SELECT k.kod, k.ad, k.tur, k.varlik, k.durum, k.aciklama, k.tanim,
       jsonb_array_length(k.ornekler) AS ornek_sayisi,
       k.kaynak, k.guncelleme,
       ARRAY(
         SELECT n.nspname || '.' || p.proname || '()'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('sistem','cekirdek') AND p.prosrc LIKE '%' || k.kod || '%'
         UNION
         SELECT n.nspname || '.' || c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('v','m') AND n.nspname IN ('sistem','cekirdek')
           AND c.relname <> 'kural_ozeti'
           AND pg_get_viewdef(c.oid) LIKE '%' || k.kod || '%'
         ORDER BY 1
       ) AS kullanan
FROM sistem.kural k;
`,u=`-- 0004 · ALAN KATALOGU + VARLIK KAYDI (hibrit alan yapisi karari, 14 Eyl 2026)
--
-- Bir kartin (kalem, partner, is merkezi...) her alani bir katalog satiridir.
--   depolama='kolon'   : MRP/stok hesabinin kullandigi ~15 evrensel alan. Gercek kolon.
--   depolama='ozellik' : geri kalan her sey. Tek \`ozellik jsonb\` kolonunda durur ve
--                        BU KATALOGA GORE dogrulanir (tip, birim, zorunlu, liste degeri, min/max).
-- Katalogda olmayan anahtar ozellik'e YAZILAMAZ -> alanlar "dalli budakli" cogalamaz.
-- Alani kapatmak (gorunur=false) veriyi SILMEZ; tekrar acildiginda deger yerindedir.
--
-- Yeni tablo acan her migration sistem.varlik_kaydet(...) cagirir. Bu tek cagri tabloya
-- olay defteri + katalog dogrulamasi + guncelleme damgasi + RLS baglar. tests/yapi.test.js
-- cagrilmamis tabloyu yakalar.

-- Supabase'de hazir gelen roller; baska Postgres'te (PGlite, yerel) yoksa olusturulur.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA sistem, cekirdek TO authenticated;
REVOKE ALL ON SCHEMA sistem, cekirdek FROM anon;

CREATE TABLE sistem.alan_tanim (
  id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  varlik             text NOT NULL,                 -- 'cekirdek.kalem'
  alan_kodu          text NOT NULL CHECK (alan_kodu ~ '^[a-z][a-z0-9_]*$'),
  etiket             text NOT NULL,
  etiket_ceviri      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(etiket_ceviri) = 'object'),  -- {"en":"Shelf life"}
  grup               text NOT NULL,
  sira               int  NOT NULL DEFAULT 100,
  tip                text NOT NULL CHECK (tip IN ('metin','uzun_metin','sayi','tamsayi','para','tarih',
                                                  'evet_hayir','liste','coklu_liste','iliski','dosya','formul')),
  birim              text,                          -- 'gun', 'kg', 'mm', '%'
  secenekler         jsonb CHECK (secenekler IS NULL OR jsonb_typeof(secenekler) = 'array'),  -- [{"deger":"A","etiket":"A sinifi"}]
  iliski_varlik      text,
  depolama           text NOT NULL CHECK (depolama IN ('kolon','ozellik')),
  sistem_alani       boolean NOT NULL DEFAULT false, -- kapatilamaz (kod, ad, tip...)
  gorunur            boolean NOT NULL DEFAULT true,
  zorunlu            boolean NOT NULL DEFAULT false,
  min_deger          numeric,
  max_deger          numeric,
  varsayilan         jsonb,
  formul             text,                          -- tip='formul' icin; hesap izi motoru (hafta 2) calistirir
  gorme_rolleri      text[],                        -- NULL = herkes
  duzenleme_rolleri  text[],                        -- NULL = gorebilen herkes
  aciklama           text,
  olusturma          timestamptz NOT NULL DEFAULT now(),
  guncelleme         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (varlik, alan_kodu),
  CHECK (tip <> 'formul' OR formul IS NOT NULL),
  CHECK (tip NOT IN ('liste','coklu_liste') OR jsonb_array_length(COALESCE(secenekler,'[]')) > 0),
  CHECK (tip <> 'iliski' OR iliski_varlik IS NOT NULL),
  CHECK (NOT sistem_alani OR gorunur),
  CHECK (min_deger IS NULL OR max_deger IS NULL OR min_deger <= max_deger)
);
CREATE TRIGGER a_guncelleme BEFORE UPDATE ON sistem.alan_tanim
FOR EACH ROW EXECUTE FUNCTION sistem.guncelleme_damgala();
SELECT sistem.olay_izlemeye_al('sistem.alan_tanim');

-- Katalog satiri gercek yapiyla tutarli mi? (kolon gercekten var mi, tablo var mi...)
CREATE OR REPLACE FUNCTION sistem.alan_tanim_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tablo regclass := to_regclass(NEW.varlik);
  v_kolon_var boolean;
BEGIN
  IF v_tablo IS NULL THEN
    RAISE EXCEPTION 'Alan katalogu: varlik % diye bir tablo yok.', NEW.varlik USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_tablo AND attname = NEW.alan_kodu AND attnum > 0 AND NOT attisdropped)
    INTO v_kolon_var;

  IF NEW.depolama = 'kolon' AND NOT v_kolon_var THEN
    RAISE EXCEPTION 'Alan katalogu: %.% "kolon" olarak tanimli ama tabloda boyle bir kolon yok.', NEW.varlik, NEW.alan_kodu
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.depolama = 'ozellik' THEN
    IF v_kolon_var THEN
      RAISE EXCEPTION 'Alan katalogu: %.% gercek bir kolonla ayni adi tasiyor; "ozellik" olamaz.', NEW.varlik, NEW.alan_kodu
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_tablo AND attname = 'ozellik' AND NOT attisdropped) THEN
      RAISE EXCEPTION 'Alan katalogu: % tablosunda ozellik kolonu yok.', NEW.varlik USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.tip = 'iliski' AND to_regclass(NEW.iliski_varlik) IS NULL THEN
    RAISE EXCEPTION 'Alan katalogu: %.% iliski hedefi % yok.', NEW.varlik, NEW.alan_kodu, NEW.iliski_varlik
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.sistem_alani AND NOT NEW.sistem_alani THEN
    RAISE EXCEPTION 'Alan katalogu: %.% sistem alanidir, sistem alani olmaktan cikarilamaz.', NEW.varlik, NEW.alan_kodu
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_alan_tanim_kapisi BEFORE INSERT OR UPDATE ON sistem.alan_tanim
FOR EACH ROW EXECUTE FUNCTION sistem.alan_tanim_kapisi();

CREATE OR REPLACE FUNCTION sistem.alan_tanim_silinemez()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sistem_alani THEN
    RAISE EXCEPTION 'Alan katalogu: %.% sistem alanidir, silinemez.', OLD.varlik, OLD.alan_kodu USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER b_alan_tanim_silinemez BEFORE DELETE ON sistem.alan_tanim
FOR EACH ROW EXECUTE FUNCTION sistem.alan_tanim_silinemez();

-- Tek bir degerin tipe uygunlugu. NULL = gecerli, metin = hata aciklamasi.
CREATE OR REPLACE FUNCTION sistem.alan_deger_hatasi(t sistem.alan_tanim, p_deger jsonb)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tur text := jsonb_typeof(p_deger);
  v_num numeric;
  v_eleman text;
BEGIN
  IF p_deger IS NULL OR v_tur = 'null' THEN RETURN NULL; END IF;

  CASE t.tip
    WHEN 'metin', 'uzun_metin', 'dosya' THEN
      IF v_tur <> 'string' THEN RETURN 'metin bekleniyordu'; END IF;
    WHEN 'sayi', 'para', 'tamsayi' THEN
      IF v_tur <> 'number' THEN RETURN 'sayi bekleniyordu'; END IF;
      v_num := (p_deger #>> '{}')::numeric;
      IF t.tip = 'tamsayi' AND v_num <> trunc(v_num) THEN RETURN 'tam sayi bekleniyordu'; END IF;
      IF t.min_deger IS NOT NULL AND v_num < t.min_deger THEN RETURN format('en az %s olmali', t.min_deger); END IF;
      IF t.max_deger IS NOT NULL AND v_num > t.max_deger THEN RETURN format('en fazla %s olmali', t.max_deger); END IF;
    WHEN 'tarih' THEN
      IF v_tur <> 'string' OR (p_deger #>> '{}') !~ '^\\d{4}-\\d{2}-\\d{2}$' THEN RETURN 'tarih (YYYY-AA-GG) bekleniyordu'; END IF;
      BEGIN
        PERFORM (p_deger #>> '{}')::date;
      EXCEPTION WHEN others THEN
        RETURN 'takvimde olmayan tarih';
      END;
    WHEN 'evet_hayir' THEN
      IF v_tur <> 'boolean' THEN RETURN 'evet/hayir bekleniyordu'; END IF;
    WHEN 'liste' THEN
      IF v_tur <> 'string' THEN RETURN 'liste degeri (metin) bekleniyordu'; END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.secenekler) s WHERE s ->> 'deger' = p_deger #>> '{}') THEN
        RETURN format('"%s" listede yok', p_deger #>> '{}');
      END IF;
    WHEN 'coklu_liste' THEN
      IF v_tur <> 'array' THEN RETURN 'deger listesi bekleniyordu'; END IF;
      FOR v_eleman IN SELECT jsonb_array_elements_text(p_deger) LOOP
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.secenekler) s WHERE s ->> 'deger' = v_eleman) THEN
          RETURN format('"%s" listede yok', v_eleman);
        END IF;
      END LOOP;
    WHEN 'iliski' THEN
      IF v_tur <> 'string' THEN RETURN 'kayit kimligi bekleniyordu'; END IF;
    WHEN 'formul' THEN
      RETURN 'formul alani hesaplanir, saklanmaz';
  END CASE;
  RETURN NULL;
END $$;

-- Kaydi kataloga gore dogrular (varlik tablolarinda BEFORE INSERT/UPDATE).
CREATE OR REPLACE FUNCTION sistem.ozellik_dogrula()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_varlik text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_kayit  jsonb := to_jsonb(NEW);
  v_oz     jsonb := COALESCE(to_jsonb(NEW) -> 'ozellik', '{}'::jsonb);
  v_anahtar text;
  t        sistem.alan_tanim;
  v_deger  jsonb;
  v_hata   text;
  v_var    boolean;
BEGIN
  IF jsonb_typeof(v_oz) <> 'object' THEN
    RAISE EXCEPTION '%.ozellik bir nesne olmali.', v_varlik USING ERRCODE = 'check_violation';
  END IF;

  FOR v_anahtar IN SELECT jsonb_object_keys(v_oz) LOOP
    IF NOT EXISTS (SELECT 1 FROM sistem.alan_tanim a WHERE a.varlik = v_varlik AND a.alan_kodu = v_anahtar AND a.depolama = 'ozellik') THEN
      RAISE EXCEPTION '%.ozellik.%: alan katalogunda tanimli degil. Once sistem.alan_tanim''a eklenmeli.', v_varlik, v_anahtar
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  FOR t IN SELECT * FROM sistem.alan_tanim a WHERE a.varlik = v_varlik LOOP
    v_deger := CASE WHEN t.depolama = 'kolon' THEN v_kayit -> t.alan_kodu ELSE v_oz -> t.alan_kodu END;

    IF t.gorunur AND t.zorunlu AND (v_deger IS NULL OR jsonb_typeof(v_deger) = 'null'
        OR (jsonb_typeof(v_deger) = 'string' AND btrim(v_deger #>> '{}') = '')) THEN
      RAISE EXCEPTION '%: "%" zorunlu alan bos birakilamaz.', v_varlik, t.etiket USING ERRCODE = 'not_null_violation';
    END IF;

    -- Kolonlarda tipi Postgres zaten korur; burada liste/min/max ve ozellik tipleri denetlenir.
    IF t.depolama = 'ozellik' OR t.tip IN ('liste','coklu_liste') OR t.min_deger IS NOT NULL OR t.max_deger IS NOT NULL THEN
      v_hata := sistem.alan_deger_hatasi(t, v_deger);
      IF v_hata IS NOT NULL THEN
        RAISE EXCEPTION '%: "%" (%) — %; gelen deger %.', v_varlik, t.etiket, t.alan_kodu, v_hata, v_deger
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF t.tip = 'iliski' AND t.depolama = 'ozellik' AND v_deger IS NOT NULL AND jsonb_typeof(v_deger) = 'string' THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE id::text = $1)', t.iliski_varlik) INTO v_var USING v_deger #>> '{}';
      IF NOT v_var THEN
        RAISE EXCEPTION '%: "%" icin % kaydi bulunamadi: %.', v_varlik, t.etiket, t.iliski_varlik, v_deger #>> '{}'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- VARLIK KAYDI: yeni tablo icin TEK cagri.
--   * olay defteri
--   * guncelleme damgasi (kolon varsa)
--   * alan katalogu dogrulamasi (ozellik kolonu varsa)
--   * RLS: firma veritabani oldugu icin giris yapmis kullanici tam erisir, anon HICBIR sey.
--     p_yalniz_ekle: defter niteligindeki tablolar (stok hareketi) — UPDATE/DELETE yetkisi yok.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.varlik_kaydet(p_tablo regclass, p_anahtar text DEFAULT 'id', p_yalniz_ekle boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_kolon_var boolean;
BEGIN
  PERFORM sistem.olay_izlemeye_al(p_tablo, p_anahtar);

  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tablo AND attname = 'guncelleme' AND NOT attisdropped) INTO v_kolon_var;
  IF v_kolon_var THEN
    EXECUTE format('DROP TRIGGER IF EXISTS a_guncelleme ON %s', p_tablo);
    EXECUTE format('CREATE TRIGGER a_guncelleme BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION sistem.guncelleme_damgala()', p_tablo);
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tablo AND attname = 'ozellik' AND NOT attisdropped) INTO v_kolon_var;
  IF v_kolon_var THEN
    EXECUTE format('DROP TRIGGER IF EXISTS b_ozellik_dogrula ON %s', p_tablo);
    EXECUTE format('CREATE TRIGGER b_ozellik_dogrula BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION sistem.ozellik_dogrula()', p_tablo);
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_tablo);
  EXECUTE format('DROP POLICY IF EXISTS firma_kullanicisi ON %s', p_tablo);
  EXECUTE format('CREATE POLICY firma_kullanicisi ON %s TO authenticated USING (true) WITH CHECK (true)', p_tablo);
  EXECUTE format('REVOKE ALL ON %s FROM anon', p_tablo);
  IF p_yalniz_ekle THEN
    EXECUTE format('REVOKE ALL ON %s FROM authenticated', p_tablo);
    EXECUTE format('GRANT SELECT, INSERT ON %s TO authenticated', p_tablo);
  ELSE
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO authenticated', p_tablo);
  END IF;
END $$;

-- Katalog tablolari da kayit altina: firma alani actiginda/kapattiginda defterde durur.
SELECT sistem.varlik_kaydet('sistem.alan_tanim');
SELECT sistem.varlik_kaydet('sistem.kural', 'kod');
SELECT sistem.varlik_kaydet('sistem.firma', 'tek');
GRANT SELECT ON sistem.olay, sistem.olay_okunur, sistem.kural_ozeti TO authenticated;

-- Ekranin okuyacagi katalog: grup/sira duzeninde, gizliler dahil (ayar ekrani hepsini gorur).
CREATE OR REPLACE VIEW sistem.alan_katalogu AS
SELECT varlik, grup, sira, alan_kodu, etiket, etiket_ceviri, tip, birim, secenekler, iliski_varlik,
       depolama, sistem_alani, gorunur, zorunlu, min_deger, max_deger, varsayilan, formul,
       gorme_rolleri, duzenleme_rolleri, aciklama
FROM sistem.alan_tanim
ORDER BY varlik, grup, sira, alan_kodu;
GRANT SELECT ON sistem.alan_katalogu TO authenticated;
`,_=`-- 0005 · CEKIRDEK: EVRENSEL URETIM VARLIKLARI
--
-- Ekmek, salca, otomotiv, iskele, yat: hepsinde ayni varliklar. Fark kayittadir, semada degil.
-- Bu dosyada "boya", "aski", "kesim programi", marka/aile adi GECMEZ (ilke 11).
--
-- Her tablo: uuid id + ozellik jsonb (alan katalogu) + olusturma/guncelleme + sistem.varlik_kaydet.
-- Turetilmis deger SAKLANMAZ (ilke 1): stok miktari tablo degil, hareketlerin toplamidir (stok_durum view).

-- ---------------------------------------------------------------------------
-- BIRIM ve DONUSUM
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.birim (
  kod           text PRIMARY KEY CHECK (kod ~ '^[a-z0-9_]+$'),
  ad            text NOT NULL,
  boyut         text NOT NULL CHECK (boyut IN ('adet','kutle','uzunluk','alan','hacim','sure','ambalaj')),
  temel_carpan  numeric CHECK (temel_carpan IS NULL OR temel_carpan > 0),
  -- ayni boyutta sabit donusum: 1 birim = temel_carpan x temel birim (kg, m, m2, m3, sn, adet).
  -- NULL = kaleme ozel (koli, boy, paket): donusumu kalem_birim tablosundan gelir.
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.birim', 'kod');

-- ---------------------------------------------------------------------------
-- DEPO / LOKASYON
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.depo (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod         text NOT NULL UNIQUE,
  ad          text NOT NULL,
  aktif       boolean NOT NULL DEFAULT true,
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.depo');

CREATE TABLE cekirdek.lokasyon (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  depo_id     uuid NOT NULL REFERENCES cekirdek.depo(id),
  kod         text NOT NULL,
  ad          text,
  aktif       boolean NOT NULL DEFAULT true,
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (depo_id, kod)
);
SELECT sistem.varlik_kaydet('cekirdek.lokasyon');

-- ---------------------------------------------------------------------------
-- KALEM: hammadde, yari mamul, mamul, sarf, hizmet — TEK tablo.
-- Sabit kolonlar yalniz MRP/stok hesabinin OKUDUGU alanlar. Geri kalan: ozellik + katalog.
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.kalem (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod                 text NOT NULL UNIQUE,
  ad                  text NOT NULL,
  tip                 text NOT NULL CHECK (tip IN ('hammadde','yari_mamul','mamul','sarf','hizmet')),
  stok_birimi         text NOT NULL REFERENCES cekirdek.birim(kod),
  planlama_yontemi    text NOT NULL DEFAULT 'mrp' CHECK (planlama_yontemi IN ('mrp','min_max','siparise','planlanmaz')),
  min_stok            numeric NOT NULL DEFAULT 0 CHECK (min_stok >= 0),
  emniyet_stoku       numeric NOT NULL DEFAULT 0 CHECK (emniyet_stoku >= 0),
  tedarik_suresi_gun  numeric NOT NULL DEFAULT 0 CHECK (tedarik_suresi_gun >= 0),
  lot_buyuklugu       numeric CHECK (lot_buyuklugu IS NULL OR lot_buyuklugu > 0),
  fire_orani          numeric NOT NULL DEFAULT 0 CHECK (fire_orani >= 0 AND fire_orani < 1),
  lot_takibi          boolean NOT NULL DEFAULT false,
  seri_takibi         boolean NOT NULL DEFAULT false,
  varsayilan_depo_id  uuid REFERENCES cekirdek.depo(id),
  aktif               boolean NOT NULL DEFAULT true,
  ozellik             jsonb NOT NULL DEFAULT '{}',
  olusturma           timestamptz NOT NULL DEFAULT now(),
  guncelleme          timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.kalem');

-- Kaleme ozel birim: 1 koli = 12 adet, 1 boy = 6 m, 1 m = 2,38 kg.
-- "hedef_miktar" hedef birim cinsinden, "kaynak" birimin 1'inin karsiligidir.
CREATE TABLE cekirdek.kalem_birim (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kalem_id      uuid NOT NULL REFERENCES cekirdek.kalem(id) ON DELETE CASCADE,
  kaynak_birim  text NOT NULL REFERENCES cekirdek.birim(kod),
  hedef_birim   text NOT NULL REFERENCES cekirdek.birim(kod),
  hedef_miktar  numeric NOT NULL CHECK (hedef_miktar > 0),
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kalem_id, kaynak_birim, hedef_birim),
  CHECK (kaynak_birim <> hedef_birim)
);
SELECT sistem.varlik_kaydet('cekirdek.kalem_birim');

-- TEK birim donusum motoru (ilke 1). Sirasi:
--   1) ayni birim                -> aynen
--   2) ayni boyut, sabit carpan  -> temel birim uzerinden
--   3) kaleme ozel donusum (iki yonlu), gerekirse sabit carpanla zincirlenir (boy -> m -> kg)
-- Yol yoksa SESSIZ 0/NULL degil, acik hata.
CREATE OR REPLACE FUNCTION cekirdek.miktar_cevir(p_kalem_id uuid, p_miktar numeric, p_kaynak text, p_hedef text)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  k cekirdek.birim; h cekirdek.birim;
  r record;
  v_ara numeric;
BEGIN
  IF p_miktar IS NULL THEN RETURN NULL; END IF;
  IF p_kaynak = p_hedef THEN RETURN p_miktar; END IF;
  SELECT * INTO k FROM cekirdek.birim WHERE kod = p_kaynak;
  SELECT * INTO h FROM cekirdek.birim WHERE kod = p_hedef;
  IF k.kod IS NULL OR h.kod IS NULL THEN
    RAISE EXCEPTION 'Birim tanimsiz: % veya %', p_kaynak, p_hedef USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF k.boyut = h.boyut AND k.temel_carpan IS NOT NULL AND h.temel_carpan IS NOT NULL THEN
    RETURN p_miktar * k.temel_carpan / h.temel_carpan;
  END IF;

  -- kaleme ozel: kaynak birimden (veya ayni boyuttaki esdegerinden) hedef birime (veya esdegerine)
  FOR r IN
    SELECT kb.kaynak_birim AS kk, kb.hedef_birim AS hk, kb.hedef_miktar AS carpan
    FROM cekirdek.kalem_birim kb WHERE kb.kalem_id = p_kalem_id
    UNION ALL
    SELECT kb.hedef_birim, kb.kaynak_birim, 1 / kb.hedef_miktar
    FROM cekirdek.kalem_birim kb WHERE kb.kalem_id = p_kalem_id
  LOOP
    BEGIN
      v_ara := cekirdek.miktar_cevir_sabit(p_miktar, p_kaynak, r.kk);   -- kaynak -> donusumun giris birimi
      IF v_ara IS NULL THEN CONTINUE; END IF;
      v_ara := v_ara * r.carpan;                                         -- donusum
      v_ara := cekirdek.miktar_cevir_sabit(v_ara, r.hk, p_hedef);       -- cikis birimi -> hedef
      IF v_ara IS NOT NULL THEN RETURN v_ara; END IF;
    END;
  END LOOP;

  RAISE EXCEPTION 'Birim donusumu yok: % -> % (kalem %). Kalem kartina donusum eklenmeli.', p_kaynak, p_hedef, p_kalem_id
    USING ERRCODE = 'data_exception';
END $$;

-- Yalniz sabit carpanla (kalemden bagimsiz) cevirir; mumkun degilse NULL.
CREATE OR REPLACE FUNCTION cekirdek.miktar_cevir_sabit(p_miktar numeric, p_kaynak text, p_hedef text)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_kaynak = p_hedef THEN p_miktar
    WHEN k.boyut = h.boyut AND k.temel_carpan IS NOT NULL AND h.temel_carpan IS NOT NULL
      THEN p_miktar * k.temel_carpan / h.temel_carpan
  END
  FROM cekirdek.birim k, cekirdek.birim h
  WHERE k.kod = p_kaynak AND h.kod = p_hedef
$$;

-- ---------------------------------------------------------------------------
-- PARTNER: musteri, tedarikci, fasoncu — tek tablo, rol dizisi.
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.partner (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod         text NOT NULL UNIQUE,
  ad          text NOT NULL,
  roller      text[] NOT NULL CHECK (cardinality(roller) > 0 AND roller <@ ARRAY['musteri','tedarikci','fasoncu']),
  vergi_no    text,
  aktif       boolean NOT NULL DEFAULT true,
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.partner');

-- ---------------------------------------------------------------------------
-- OPERASYON ROLU ve OPERASYON
-- Cekirdek kod operasyonu KODUYLA ('023') degil ROLUYLE tanir. Eski UYS'de ~80 yerde gomulu
-- operasyon kodu vardi. sistem_rolu=true olanlar cekirdegin davranis bagladigi rollerdir;
-- firma kendi rollerini ekleyebilir.
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.operasyon_rolu (
  kod          text PRIMARY KEY CHECK (kod ~ '^[a-z][a-z0-9_]*$'),
  ad           text NOT NULL,
  sistem_rolu  boolean NOT NULL DEFAULT false,
  aciklama     text,
  olusturma    timestamptz NOT NULL DEFAULT now(),
  guncelleme   timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.operasyon_rolu', 'kod');

CREATE TABLE cekirdek.is_merkezi (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod                 text NOT NULL UNIQUE,
  ad                  text NOT NULL,
  saat_maliyeti       numeric CHECK (saat_maliyeti IS NULL OR saat_maliyeti >= 0),
  gunluk_kapasite_saat numeric CHECK (gunluk_kapasite_saat IS NULL OR gunluk_kapasite_saat > 0),
  paralel_kaynak      int NOT NULL DEFAULT 1 CHECK (paralel_kaynak > 0),
  aktif               boolean NOT NULL DEFAULT true,
  ozellik             jsonb NOT NULL DEFAULT '{}',
  olusturma           timestamptz NOT NULL DEFAULT now(),
  guncelleme          timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.is_merkezi');

CREATE TABLE cekirdek.operasyon (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod                     text NOT NULL UNIQUE,
  ad                      text NOT NULL,
  rol                     text NOT NULL REFERENCES cekirdek.operasyon_rolu(kod),
  varsayilan_is_merkezi_id uuid REFERENCES cekirdek.is_merkezi(id),
  aktif                   boolean NOT NULL DEFAULT true,
  ozellik                 jsonb NOT NULL DEFAULT '{}',
  olusturma               timestamptz NOT NULL DEFAULT now(),
  guncelleme              timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.operasyon');

-- Kaynak: operator ya da makine. Yetkinlik ayri tabloda.
CREATE TABLE cekirdek.kaynak (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod            text NOT NULL UNIQUE,
  ad             text NOT NULL,
  tur            text NOT NULL CHECK (tur IN ('operator','makine')),
  is_merkezi_id  uuid REFERENCES cekirdek.is_merkezi(id),
  saat_maliyeti  numeric CHECK (saat_maliyeti IS NULL OR saat_maliyeti >= 0),
  aktif          boolean NOT NULL DEFAULT true,
  ozellik        jsonb NOT NULL DEFAULT '{}',
  olusturma      timestamptz NOT NULL DEFAULT now(),
  guncelleme     timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.kaynak');

CREATE TABLE cekirdek.yetkinlik (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kaynak_id     uuid NOT NULL REFERENCES cekirdek.kaynak(id) ON DELETE CASCADE,
  operasyon_id  uuid NOT NULL REFERENCES cekirdek.operasyon(id) ON DELETE CASCADE,
  seviye        int NOT NULL CHECK (seviye BETWEEN 1 AND 4),   -- 1 ogrenci · 2 gozetimli · 3 bagimsiz · 4 egitmen
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kaynak_id, operasyon_id)
);
SELECT sistem.varlik_kaydet('cekirdek.yetkinlik');

-- ---------------------------------------------------------------------------
-- TAKVIM
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.vardiya (
  kod         text PRIMARY KEY CHECK (kod ~ '^[a-z0-9_]+$'),
  ad          text NOT NULL,
  baslangic   time NOT NULL,
  bitis       time NOT NULL,       -- baslangictan kucukse gece yarisini gecer
  mola_dk     int NOT NULL DEFAULT 0 CHECK (mola_dk >= 0),
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.vardiya', 'kod');

CREATE TABLE cekirdek.takvim_gun (
  tarih       date PRIMARY KEY,
  tur         text NOT NULL CHECK (tur IN ('calisma','hafta_sonu','tatil','yarim_gun','bakim')),
  aciklama    text,
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.takvim_gun', 'tarih');

-- ---------------------------------------------------------------------------
-- URUN AGACI (surumlu) ve ROTA (surumlu)
-- Bir kalemin ayni anda tek AKTIF surumu olur (kismi benzersiz indeks).
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.urun_agaci (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kalem_id    uuid NOT NULL REFERENCES cekirdek.kalem(id),
  surum       int NOT NULL CHECK (surum > 0),
  durum       text NOT NULL DEFAULT 'taslak' CHECK (durum IN ('taslak','aktif','emekli')),
  temel_miktar numeric NOT NULL DEFAULT 1 CHECK (temel_miktar > 0),  -- agac bu kadar kalem icindir (parti uretim: 100 kg salca)
  aciklama    text,
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kalem_id, surum)
);
CREATE UNIQUE INDEX urun_agaci_tek_aktif ON cekirdek.urun_agaci (kalem_id) WHERE durum = 'aktif';
SELECT sistem.varlik_kaydet('cekirdek.urun_agaci');

CREATE TABLE cekirdek.rota (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kalem_id    uuid NOT NULL REFERENCES cekirdek.kalem(id),
  surum       int NOT NULL CHECK (surum > 0),
  durum       text NOT NULL DEFAULT 'taslak' CHECK (durum IN ('taslak','aktif','emekli')),
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kalem_id, surum)
);
CREATE UNIQUE INDEX rota_tek_aktif ON cekirdek.rota (kalem_id) WHERE durum = 'aktif';
SELECT sistem.varlik_kaydet('cekirdek.rota');

CREATE TABLE cekirdek.rota_adim (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rota_id           uuid NOT NULL REFERENCES cekirdek.rota(id) ON DELETE CASCADE,
  sira              int NOT NULL CHECK (sira > 0),
  operasyon_id      uuid NOT NULL REFERENCES cekirdek.operasyon(id),
  is_merkezi_id     uuid REFERENCES cekirdek.is_merkezi(id),
  hazirlik_dk       numeric NOT NULL DEFAULT 0 CHECK (hazirlik_dk >= 0),
  islem_dk          numeric NOT NULL DEFAULT 0 CHECK (islem_dk >= 0),   -- birim basina
  parti_buyuklugu   numeric CHECK (parti_buyuklugu IS NULL OR parti_buyuklugu > 0),
  ozellik           jsonb NOT NULL DEFAULT '{}',
  olusturma         timestamptz NOT NULL DEFAULT now(),
  guncelleme        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rota_id, sira)
);
SELECT sistem.varlik_kaydet('cekirdek.rota_adim');

CREATE TABLE cekirdek.urun_agaci_satir (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agac_id           uuid NOT NULL REFERENCES cekirdek.urun_agaci(id) ON DELETE CASCADE,
  sira              int NOT NULL CHECK (sira > 0),
  bilesen_kalem_id  uuid NOT NULL REFERENCES cekirdek.kalem(id),
  miktar            numeric NOT NULL CHECK (miktar > 0),
  birim             text NOT NULL REFERENCES cekirdek.birim(kod),
  fire_orani        numeric NOT NULL DEFAULT 0 CHECK (fire_orani >= 0 AND fire_orani < 1),
  tuketen_adim_sira int,          -- rotanin hangi adiminda tuketilir (NULL = ilk adim)
  alternatif_grubu  text,         -- ayni gruptakilerden biri kullanilir
  ozellik           jsonb NOT NULL DEFAULT '{}',
  olusturma         timestamptz NOT NULL DEFAULT now(),
  guncelleme        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agac_id, sira)
);
SELECT sistem.varlik_kaydet('cekirdek.urun_agaci_satir');

-- Agac kendini icermesin (dogrudan dongu). Dolayli dongu MRP patlatmasinda yakalanir.
CREATE OR REPLACE FUNCTION cekirdek.agac_dongu_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.id = NEW.agac_id AND a.kalem_id = NEW.bilesen_kalem_id) THEN
    RAISE EXCEPTION 'Urun agaci kendini bilesen olarak iceremez.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_agac_dongu BEFORE INSERT OR UPDATE ON cekirdek.urun_agaci_satir
FOR EACH ROW EXECUTE FUNCTION cekirdek.agac_dongu_kapisi();

-- ---------------------------------------------------------------------------
-- BELGE: satis, satin alma, uretim, fason, transfer, sayim, sevk, giris — hepsi baslik + satir.
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.belge (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tur              text NOT NULL CHECK (tur IN ('satis_siparisi','satinalma_siparisi','uretim_emri','fason_emri',
                                                'transfer','sayim','sevk','mal_kabul','acilis')),
  no               text NOT NULL,
  tarih            date NOT NULL DEFAULT current_date,
  partner_id       uuid REFERENCES cekirdek.partner(id),
  termin           date,
  durum            text NOT NULL DEFAULT 'taslak' CHECK (durum IN ('taslak','onayli','devam','tamam','iptal')),
  kaynak_belge_id  uuid REFERENCES cekirdek.belge(id),   -- uretim emri <- satis siparisi
  aciklama         text,
  ozellik          jsonb NOT NULL DEFAULT '{}',
  olusturma        timestamptz NOT NULL DEFAULT now(),
  guncelleme       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tur, no)
);
SELECT sistem.varlik_kaydet('cekirdek.belge');

CREATE TABLE cekirdek.belge_satir (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  belge_id         uuid NOT NULL REFERENCES cekirdek.belge(id) ON DELETE CASCADE,
  sira             int NOT NULL CHECK (sira > 0),
  kalem_id         uuid NOT NULL REFERENCES cekirdek.kalem(id),
  miktar           numeric NOT NULL CHECK (miktar > 0),
  birim            text NOT NULL REFERENCES cekirdek.birim(kod),
  termin           date,
  birim_fiyat      numeric CHECK (birim_fiyat IS NULL OR birim_fiyat >= 0),
  kaynak_satir_id  uuid REFERENCES cekirdek.belge_satir(id),
  durum            text NOT NULL DEFAULT 'acik' CHECK (durum IN ('acik','kismi','tamam','iptal')),
  ozellik          jsonb NOT NULL DEFAULT '{}',
  olusturma        timestamptz NOT NULL DEFAULT now(),
  guncelleme       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (belge_id, sira)
);
SELECT sistem.varlik_kaydet('cekirdek.belge_satir');

-- ---------------------------------------------------------------------------
-- LOT ve STOK HAREKETI (defter)
-- Stok bir TABLO DEGIL, hareketlerin toplamidir. Hareket guncellenmez/silinmez; duzeltme = ters hareket.
-- Her hareket bir belge satirina baglidir (acilis stoku da 'acilis' belgesiyle gelir).
-- Miktar HER ZAMAN kalemin stok biriminde, isaretli: giris +, cikis -.
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.lot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kalem_id        uuid NOT NULL REFERENCES cekirdek.kalem(id),
  lot_no          text NOT NULL,
  uretim_tarihi   date,
  son_kullanma    date,
  ozellik         jsonb NOT NULL DEFAULT '{}',
  olusturma       timestamptz NOT NULL DEFAULT now(),
  guncelleme      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kalem_id, lot_no),
  CHECK (son_kullanma IS NULL OR uretim_tarihi IS NULL OR son_kullanma >= uretim_tarihi)
);
SELECT sistem.varlik_kaydet('cekirdek.lot');

CREATE TABLE cekirdek.stok_hareket (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zaman           timestamptz NOT NULL DEFAULT clock_timestamp(),
  kalem_id        uuid NOT NULL REFERENCES cekirdek.kalem(id),
  depo_id         uuid NOT NULL REFERENCES cekirdek.depo(id),
  lokasyon_id     uuid REFERENCES cekirdek.lokasyon(id),
  lot_id          uuid REFERENCES cekirdek.lot(id),
  miktar          numeric NOT NULL CHECK (miktar <> 0),
  tur             text NOT NULL CHECK (tur IN ('acilis','mal_kabul','satis_cikis','uretim_tuketim','uretim_cikti',
                                               'transfer_cikis','transfer_giris','sayim_farki','fire','ters_kayit')),
  belge_satir_id  uuid NOT NULL REFERENCES cekirdek.belge_satir(id),
  ters_hareket_id uuid REFERENCES cekirdek.stok_hareket(id),   -- 'ters_kayit' neyi duzeltiyor
  aciklama        text,
  olusturma       timestamptz NOT NULL DEFAULT now(),
  CHECK ((tur = 'ters_kayit') = (ters_hareket_id IS NOT NULL)),
  CHECK (tur NOT IN ('acilis','mal_kabul','uretim_cikti','transfer_giris') OR miktar > 0),
  CHECK (tur NOT IN ('satis_cikis','uretim_tuketim','transfer_cikis','fire') OR miktar < 0)
);
CREATE INDEX stok_hareket_kalem_depo ON cekirdek.stok_hareket (kalem_id, depo_id);
CREATE INDEX stok_hareket_belge ON cekirdek.stok_hareket (belge_satir_id);
SELECT sistem.varlik_kaydet('cekirdek.stok_hareket', 'id', true);

CREATE OR REPLACE FUNCTION cekirdek.stok_hareket_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kalem cekirdek.kalem;
  v_lot_kalem uuid;
  v_ters cekirdek.stok_hareket;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Stok hareketi degistirilemez/silinemez. Duzeltme icin "ters_kayit" hareketi girin.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_kalem FROM cekirdek.kalem WHERE id = NEW.kalem_id;
  IF v_kalem.lot_takibi AND NEW.lot_id IS NULL THEN
    RAISE EXCEPTION 'Kalem % lot takiplidir: hareket lot olmadan girilemez.', v_kalem.kod USING ERRCODE = 'not_null_violation';
  END IF;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT kalem_id INTO v_lot_kalem FROM cekirdek.lot WHERE id = NEW.lot_id;
    IF v_lot_kalem <> NEW.kalem_id THEN
      RAISE EXCEPTION 'Lot baska bir kaleme ait.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.lokasyon_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cekirdek.lokasyon WHERE id = NEW.lokasyon_id AND depo_id = NEW.depo_id) THEN
    RAISE EXCEPTION 'Lokasyon bu depoya ait degil.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tur = 'ters_kayit' THEN
    SELECT * INTO v_ters FROM cekirdek.stok_hareket WHERE id = NEW.ters_hareket_id;
    IF v_ters.kalem_id <> NEW.kalem_id OR v_ters.depo_id <> NEW.depo_id
       OR v_ters.lot_id IS DISTINCT FROM NEW.lot_id OR v_ters.miktar <> -NEW.miktar THEN
      RAISE EXCEPTION 'Ters kayit, duzelttigi hareketin tam tersi olmali (ayni kalem/depo/lot, miktar %).', -v_ters.miktar
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE ters_hareket_id = NEW.ters_hareket_id) THEN
      RAISE EXCEPTION 'Bu hareket zaten ters kayitla duzeltilmis.' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_stok_hareket_kapisi BEFORE INSERT OR UPDATE OR DELETE ON cekirdek.stok_hareket
FOR EACH ROW EXECUTE FUNCTION cekirdek.stok_hareket_kapisi();

-- Stok durumu: TABLO DEGIL. Her okuma defterden hesaplanir; bayat olamaz.
CREATE OR REPLACE VIEW cekirdek.stok_durum AS
SELECT h.kalem_id, h.depo_id, h.lot_id,
       sum(h.miktar) AS miktar,
       max(h.zaman)  AS son_hareket
FROM cekirdek.stok_hareket h
GROUP BY h.kalem_id, h.depo_id, h.lot_id
HAVING sum(h.miktar) <> 0;
GRANT SELECT ON cekirdek.stok_durum TO authenticated;

-- Belirli andaki stok (zamanda geri git, stok icin).
CREATE OR REPLACE FUNCTION cekirdek.stok_ani(p_kalem_id uuid, p_zaman timestamptz, p_depo_id uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(miktar), 0) FROM cekirdek.stok_hareket
  WHERE kalem_id = p_kalem_id AND zaman <= p_zaman AND (p_depo_id IS NULL OR depo_id = p_depo_id)
$$;
`,N=`-- 0006 · GORUNUM ve TEMA (ilke 7: gorunum kullaniciya ait)
--
-- Eski UYS'de: varsayilan filtreler kodda useState ile gomuluydu; renk tokenlari vardi ama
-- sayfalarda 4.948 sabit renk sinifi tokeni atliyordu. Kullanici hicbirini degistiremiyordu.
--
-- GORUNUM: bir tablonun kaydedilmis hali — sutunlar (sira, genislik, gizli, sabit, sar),
-- siralama, filtre, gruplama, kosullu bicim. Kapsam: firma > rol > kullanici.
-- Varsayilan cozumu: kullanici varsayilani > rol varsayilani > firma varsayilani > (yok: katalog sirasi).
--
-- TEMA: anlam tokenlari ("zemin", "vurgu", "uyari") icin deger. Token LISTESI sistemde sabittir
-- (tema_token), DEGERLERI firma/rol/kullanici degistirir. Bilinmeyen token ya da gecersiz renk yazilamaz.

CREATE TABLE sistem.gorunum (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sayfa         text NOT NULL CHECK (sayfa ~ '^[a-z][a-z0-9_.-]*$'),
  ad            text NOT NULL,
  kapsam        text NOT NULL CHECK (kapsam IN ('firma','rol','kullanici')),
  kapsam_deger  text,          -- rol adi / kullanici kimligi; firma icin NULL
  tanim         jsonb NOT NULL CHECK (jsonb_typeof(tanim) = 'object'),
  varsayilan    boolean NOT NULL DEFAULT false,
  olusturan     text,
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kapsam = 'firma') = (kapsam_deger IS NULL)),
  CHECK (jsonb_typeof(COALESCE(tanim -> 'sutunlar', '[]')) = 'array'),
  UNIQUE (sayfa, kapsam, kapsam_deger, ad)
);
-- Her kapsamda tek varsayilan. (kapsam_deger NULL olabildigi icin COALESCE.)
CREATE UNIQUE INDEX gorunum_tek_varsayilan
  ON sistem.gorunum (sayfa, kapsam, COALESCE(kapsam_deger, '')) WHERE varsayilan;
SELECT sistem.varlik_kaydet('sistem.gorunum');

-- Sutun tanimi dogrulamasi: genislik elle "sayi yazma" ile degil surukle/sigdir ile gelir,
-- ama saklanan deger yine de makul araliktadir.
CREATE OR REPLACE FUNCTION sistem.gorunum_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s jsonb;
  i int := 0;
BEGIN
  FOR s IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.tanim -> 'sutunlar', '[]')) LOOP
    i := i + 1;
    IF NOT (s ? 'alan') OR jsonb_typeof(s -> 'alan') <> 'string' THEN
      RAISE EXCEPTION 'Gorunum "%": sutun % icin "alan" zorunlu.', NEW.ad, i USING ERRCODE = 'check_violation';
    END IF;
    IF s ? 'genislik' AND (jsonb_typeof(s -> 'genislik') <> 'number'
        OR (s ->> 'genislik')::numeric < 24 OR (s ->> 'genislik')::numeric > 2000) THEN
      RAISE EXCEPTION 'Gorunum "%": % sutununun genisligi 24-2000 px arasinda olmali.', NEW.ad, s ->> 'alan' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER b_gorunum_kapisi BEFORE INSERT OR UPDATE ON sistem.gorunum
FOR EACH ROW EXECUTE FUNCTION sistem.gorunum_kapisi();

-- Bir kullanicinin o sayfada acilista gorecegi gorunum.
CREATE OR REPLACE FUNCTION sistem.varsayilan_gorunum(p_sayfa text, p_kullanici text, p_roller text[] DEFAULT '{}')
RETURNS sistem.gorunum LANGUAGE sql STABLE AS $$
  SELECT g.* FROM sistem.gorunum g
  WHERE g.sayfa = p_sayfa AND g.varsayilan
    AND ( (g.kapsam = 'kullanici' AND g.kapsam_deger = p_kullanici)
       OR (g.kapsam = 'rol' AND g.kapsam_deger = ANY (p_roller))
       OR  g.kapsam = 'firma')
  ORDER BY CASE g.kapsam WHEN 'kullanici' THEN 1 WHEN 'rol' THEN 2 ELSE 3 END,
           array_position(p_roller, g.kapsam_deger)
  LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- TEMA
-- ---------------------------------------------------------------------------
CREATE TABLE sistem.tema_token (
  ad             text PRIMARY KEY CHECK (ad ~ '^[a-z][a-z0-9-]*$'),
  tur            text NOT NULL CHECK (tur IN ('renk','boyut','yogunluk','yazi')),
  grup           text NOT NULL,
  varsayilan_acik  text NOT NULL,
  varsayilan_koyu  text NOT NULL,
  aciklama       text NOT NULL,
  olusturma      timestamptz NOT NULL DEFAULT now(),
  guncelleme     timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('sistem.tema_token', 'ad');

CREATE TABLE sistem.tema (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kapsam        text NOT NULL CHECK (kapsam IN ('firma','rol','kullanici')),
  kapsam_deger  text,
  mod           text NOT NULL CHECK (mod IN ('acik','koyu')),
  degerler      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(degerler) = 'object'),  -- {"vurgu":"#1440a8"}
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kapsam = 'firma') = (kapsam_deger IS NULL))
);
CREATE UNIQUE INDEX tema_tek ON sistem.tema (kapsam, COALESCE(kapsam_deger, ''), mod);
SELECT sistem.varlik_kaydet('sistem.tema');

CREATE OR REPLACE FUNCTION sistem.tema_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ad  text;
  v_tur text;
  v_deger text;
BEGIN
  FOR v_ad, v_deger IN SELECT key, value FROM jsonb_each_text(NEW.degerler) LOOP
    SELECT tur INTO v_tur FROM sistem.tema_token WHERE ad = v_ad;
    IF v_tur IS NULL THEN
      RAISE EXCEPTION 'Tema: "%" diye bir token yok. Gecerli tokenlar sistem.tema_token tablosunda.', v_ad USING ERRCODE = 'check_violation';
    END IF;
    IF v_tur = 'renk' AND v_deger !~ '^#[0-9a-fA-F]{6}$' THEN
      RAISE EXCEPTION 'Tema: "%" renk olmali (#RRGGBB), gelen "%".', v_ad, v_deger USING ERRCODE = 'check_violation';
    END IF;
    IF v_tur = 'boyut' AND v_deger !~ '^[0-9]+(\\.[0-9]+)?(px|rem)$' THEN
      RAISE EXCEPTION 'Tema: "%" boyut olmali (orn. 13px), gelen "%".', v_ad, v_deger USING ERRCODE = 'check_violation';
    END IF;
    IF v_tur = 'yogunluk' AND v_deger NOT IN ('dar','normal','genis') THEN
      RAISE EXCEPTION 'Tema: "%" dar/normal/genis olmali, gelen "%".', v_ad, v_deger USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER b_tema_kapisi BEFORE INSERT OR UPDATE ON sistem.tema
FOR EACH ROW EXECUTE FUNCTION sistem.tema_kapisi();

-- Etkin tema: token varsayilani <- firma <- rol <- kullanici (sonraki oncekini ezer).
CREATE OR REPLACE FUNCTION sistem.etkin_tema(p_mod text, p_kullanici text DEFAULT NULL, p_roller text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT jsonb_object_agg(ad, CASE WHEN p_mod = 'koyu' THEN varsayilan_koyu ELSE varsayilan_acik END) FROM sistem.tema_token)
    || COALESCE((SELECT degerler FROM sistem.tema WHERE kapsam = 'firma' AND mod = p_mod), '{}')
    || COALESCE((SELECT jsonb_object_agg(k, v) FROM (
          SELECT e.key AS k, e.value AS v
          FROM sistem.tema t, jsonb_each(t.degerler) e, unnest(p_roller) WITH ORDINALITY r(rol, sira)
          WHERE t.kapsam = 'rol' AND t.kapsam_deger = r.rol AND t.mod = p_mod
          ORDER BY r.sira DESC) x), '{}')
    || COALESCE((SELECT degerler FROM sistem.tema WHERE kapsam = 'kullanici' AND kapsam_deger = p_kullanici AND mod = p_mod), '{}')
$$;
`,y=`-- 0007 · CEKIRDEK TOHUM: her firmada ayni olan baslangic kayitlari
--
-- Firmaya ozel HICBIR sey yok (kod sablonu, kardes eki, urun ailesi -> firma/<ad>/ paketi).
-- Kaynak: 'kurulum'. Olay defterinde "kurulum" olarak gorunur.

SELECT sistem.baglam_kur('kurulum', NULL, '0007_tohum', 'cekirdek tohum');

-- Birimler -----------------------------------------------------------------
INSERT INTO cekirdek.birim (kod, ad, boyut, temel_carpan) VALUES
  ('adet', 'Adet', 'adet', 1),
  ('duzine', 'Düzine', 'adet', 12),
  ('g', 'Gram', 'kutle', 0.001), ('kg', 'Kilogram', 'kutle', 1), ('ton', 'Ton', 'kutle', 1000),
  ('mm', 'Milimetre', 'uzunluk', 0.001), ('cm', 'Santimetre', 'uzunluk', 0.01), ('m', 'Metre', 'uzunluk', 1),
  ('m2', 'Metrekare', 'alan', 1), ('dm2', 'Desimetrekare', 'alan', 0.01),
  ('lt', 'Litre', 'hacim', 0.001), ('ml', 'Mililitre', 'hacim', 0.000001), ('m3', 'Metreküp', 'hacim', 1),
  ('sn', 'Saniye', 'sure', 1), ('dk', 'Dakika', 'sure', 60), ('saat', 'Saat', 'sure', 3600),
  ('koli', 'Koli', 'ambalaj', NULL), ('paket', 'Paket', 'ambalaj', NULL),
  ('boy', 'Boy', 'ambalaj', NULL), ('rulo', 'Rulo', 'ambalaj', NULL), ('palet', 'Palet', 'ambalaj', NULL);

-- Operasyon rolleri: cekirdegin davranis bagladiklari sistem_rolu=true ---------------
INSERT INTO cekirdek.operasyon_rolu (kod, ad, sistem_rolu, aciklama) VALUES
  ('dis_tedarik',   'Dış tedarik / fason', true,  'İş dışarıda yapılır: süre kapasiteye yazılmaz, fason belgesi açılır.'),
  ('kalite',        'Kalite kontrol',      true,  'Onay adımı: geçmeden sonraki adım başlamaz.'),
  ('paketleme',     'Paketleme',           true,  'Mamul çıktısı bu adımdan sonra stoğa girer.'),
  ('kesim',         'Kesim',               false, NULL),
  ('sekillendirme', 'Şekillendirme',       false, 'Büküm, pres, dövme, döküm.'),
  ('birlestirme',   'Birleştirme',         false, 'Kaynak, perçin, cıvata, yapıştırma.'),
  ('montaj',        'Montaj',              false, NULL),
  ('talasli',       'Talaşlı imalat',      false, 'Torna, freze, delme.'),
  ('yuzey_islem',   'Yüzey işlem',         false, 'Boya, galvaniz, kaplama, kumlama.'),
  ('isil_islem',    'Isıl işlem',          false, NULL),
  ('karistirma',    'Karıştırma',          false, 'Gıda, kimya: reçete oranında karışım.'),
  ('pisirme',       'Pişirme / fırın',     false, NULL),
  ('dolum',         'Dolum',               false, NULL),
  ('diger',         'Diğer',               false, NULL);

-- Tema tokenlari: eski UYS index.css degerlerinden (kontrast olcumleriyle birlikte tasindi) -----
INSERT INTO sistem.tema_token (ad, tur, grup, varsayilan_acik, varsayilan_koyu, aciklama) VALUES
  ('zemin',          'renk', 'yuzey',  '#ffffff', '#12161b', 'Sayfa zemini'),
  ('yuzey',          'renk', 'yuzey',  '#ffffff', '#181e25', 'Kart, girdi, yan panel'),
  ('yuzey-ikincil',  'renk', 'yuzey',  '#eaeaea', '#1f2730', 'Araç çubuğu, tablo başlığı'),
  ('vurgulu-satir',  'renk', 'yuzey',  '#d8d8d8', '#27313b', 'Üzerine gelinen satır'),
  ('cizgi',          'renk', 'cizgi',  '#949494', '#3a4552', 'Kılavuz çizgisi (en az 3:1)'),
  ('cizgi-guclu',    'renk', 'cizgi',  '#707070', '#56626f', 'Dış çerçeve, başlık altı'),
  ('yazi',           'renk', 'yazi',   '#111111', '#e6ebef', 'Ana metin'),
  ('yazi-soluk',     'renk', 'yazi',   '#4b5563', '#9aa6b2', 'İkincil metin'),
  ('vurgu',          'renk', 'anlam',  '#1440a8', '#8ab4e0', 'Birincil eylem, seçim'),
  ('iyi',            'renk', 'anlam',  '#04543b', '#7cc79c', 'Tamam, geçti'),
  ('uyari',          'renk', 'anlam',  '#7c2d12', '#e0b56a', 'Dikkat'),
  ('kritik',         'renk', 'anlam',  '#991b1b', '#ee8e7c', 'Hata, durdurucu'),
  ('bilgi',          'renk', 'anlam',  '#0c4a6e', '#86c5e8', 'Bilgi'),
  ('yazi-boyu',      'boyut', 'yazi',  '13px',    '13px',    'Temel yazı boyutu'),
  ('tablo-yazi-boyu','boyut', 'yazi',  '12px',    '12px',    'Tablo hücresi yazı boyutu'),
  ('yogunluk',       'yogunluk','yerlesim','normal','normal', 'Satır yüksekliği ve iç boşluk');

-- ALAN KATALOGU: KALEM ---------------------------------------------------------
-- Sabit kolonlar (depolama='kolon'). sistem_alani = kapatilamaz.
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, secenekler, depolama, sistem_alani, gorunur, zorunlu, birim, min_deger, max_deger, aciklama) VALUES
  ('cekirdek.kalem','kod','Kod','{"en":"Code"}','Kimlik',10,'metin',NULL,'kolon',true,true,true,NULL,NULL,NULL,'Firma kod şablonuna uymalı (kural sözlüğü).'),
  ('cekirdek.kalem','ad','Ad','{"en":"Name"}','Kimlik',20,'metin',NULL,'kolon',true,true,true,NULL,NULL,NULL,NULL),
  ('cekirdek.kalem','tip','Tip','{"en":"Type"}','Sınıflandırma',10,'liste',
     '[{"deger":"hammadde","etiket":"Hammadde"},{"deger":"yari_mamul","etiket":"Yarı mamul"},{"deger":"mamul","etiket":"Mamul"},{"deger":"sarf","etiket":"Sarf"},{"deger":"hizmet","etiket":"Hizmet"}]',
     'kolon',true,true,true,NULL,NULL,NULL,NULL),
  ('cekirdek.kalem','aktif','Aktif','{"en":"Active"}','Kimlik',90,'evet_hayir',NULL,'kolon',true,true,false,NULL,NULL,NULL,NULL),
  ('cekirdek.kalem','planlama_yontemi','Planlama yöntemi','{"en":"Planning method"}','Stok ve planlama',10,'liste',
     '[{"deger":"mrp","etiket":"MRP"},{"deger":"min_max","etiket":"Min-max"},{"deger":"siparise","etiket":"Siparişe"},{"deger":"planlanmaz","etiket":"Planlanmaz"}]',
     'kolon',false,true,false,NULL,NULL,NULL,NULL),
  ('cekirdek.kalem','min_stok','Min stok','{"en":"Min stock"}','Stok ve planlama',20,'sayi',NULL,'kolon',false,true,false,NULL,0,NULL,NULL),
  ('cekirdek.kalem','emniyet_stoku','Emniyet stoku','{"en":"Safety stock"}','Stok ve planlama',30,'sayi',NULL,'kolon',false,false,false,NULL,0,NULL,NULL),
  ('cekirdek.kalem','tedarik_suresi_gun','Tedarik süresi','{"en":"Lead time"}','Stok ve planlama',40,'sayi',NULL,'kolon',false,true,false,'gun',0,NULL,NULL),
  ('cekirdek.kalem','lot_buyuklugu','Lot büyüklüğü','{"en":"Lot size"}','Stok ve planlama',50,'sayi',NULL,'kolon',false,false,false,NULL,NULL,NULL,NULL),
  ('cekirdek.kalem','fire_orani','Fire oranı','{"en":"Scrap rate"}','Üretim',10,'sayi',NULL,'kolon',false,false,false,'oran',0,0.99,'0,05 = %5'),
  ('cekirdek.kalem','lot_takibi','Lot takibi','{"en":"Lot tracking"}','Kalite ve izlenebilirlik',10,'evet_hayir',NULL,'kolon',false,false,false,NULL,NULL,NULL,NULL),
  ('cekirdek.kalem','seri_takibi','Seri no takibi','{"en":"Serial tracking"}','Kalite ve izlenebilirlik',20,'evet_hayir',NULL,'kolon',false,false,false,NULL,NULL,NULL,NULL);

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu) VALUES
  ('cekirdek.kalem','stok_birimi','Stok birimi','{"en":"Stock unit"}','Birim',10,'iliski','cekirdek.birim','kolon',true,true,true),
  ('cekirdek.kalem','varsayilan_depo_id','Varsayılan depo','{"en":"Default warehouse"}','Stok ve planlama',90,'iliski','cekirdek.depo','kolon',false,true,false);

-- Ek alanlar (depolama='ozellik'). Varsayilan: yaygin olanlar acik, sektore ozel olanlar kapali.
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, secenekler, depolama, gorunur, birim, min_deger, aciklama) VALUES
  ('cekirdek.kalem','kisa_ad','Kısa ad','{"en":"Short name"}','Kimlik',30,'metin',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','yabanci_ad','Yabancı ad','{"en":"Foreign name"}','Kimlik',40,'metin',NULL,'ozellik',false,NULL,NULL,'İhracat belgeleri için.'),
  ('cekirdek.kalem','barkod','Barkod / GTIN','{"en":"Barcode / GTIN"}','Kimlik',50,'metin',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','musteri_urun_kodu','Müşteri ürün kodu','{"en":"Customer part no"}','Kimlik',60,'metin',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','revizyon','Revizyon','{"en":"Revision"}','Kimlik',70,'metin',NULL,'ozellik',true,NULL,NULL,NULL),
  ('cekirdek.kalem','urun_grubu','Ürün grubu','{"en":"Product group"}','Sınıflandırma',20,'metin',NULL,'ozellik',true,NULL,NULL,NULL),
  ('cekirdek.kalem','urun_ailesi','Ürün ailesi','{"en":"Product family"}','Sınıflandırma',30,'metin',NULL,'ozellik',true,NULL,NULL,'Aile kuralları ürün adına değil bu alana bağlanır.'),
  ('cekirdek.kalem','malzeme_cinsi','Malzeme cinsi','{"en":"Material grade"}','Sınıflandırma',40,'metin',NULL,'ozellik',true,NULL,NULL,NULL),
  ('cekirdek.kalem','abc_sinifi','ABC sınıfı','{"en":"ABC class"}','Sınıflandırma',50,'liste','[{"deger":"A","etiket":"A"},{"deger":"B","etiket":"B"},{"deger":"C","etiket":"C"}]','ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','birim_agirlik','Birim ağırlık','{"en":"Unit weight"}','Birim',20,'sayi',NULL,'ozellik',true,'kg',0,NULL),
  ('cekirdek.kalem','en','En','{"en":"Width"}','Ölçü ve geometri',10,'sayi',NULL,'ozellik',true,'mm',0,NULL),
  ('cekirdek.kalem','boy','Boy','{"en":"Height"}','Ölçü ve geometri',20,'sayi',NULL,'ozellik',true,'mm',0,NULL),
  ('cekirdek.kalem','kalinlik','Kalınlık','{"en":"Thickness"}','Ölçü ve geometri',30,'sayi',NULL,'ozellik',true,'mm',0,NULL),
  ('cekirdek.kalem','uzunluk','Uzunluk','{"en":"Length"}','Ölçü ve geometri',40,'sayi',NULL,'ozellik',true,'mm',0,NULL),
  ('cekirdek.kalem','cap','Çap','{"en":"Diameter"}','Ölçü ve geometri',50,'sayi',NULL,'ozellik',false,'mm',0,NULL),
  ('cekirdek.kalem','ic_cap','İç çap','{"en":"Inner diameter"}','Ölçü ve geometri',60,'sayi',NULL,'ozellik',false,'mm',0,NULL),
  ('cekirdek.kalem','hacim','Hacim','{"en":"Volume"}','Ölçü ve geometri',70,'sayi',NULL,'ozellik',false,'m3',0,NULL),
  ('cekirdek.kalem','yuzey_alani','Yüzey alanı','{"en":"Surface area"}','Ölçü ve geometri',80,'sayi',NULL,'ozellik',false,'m2',0,NULL),
  ('cekirdek.kalem','max_stok','Max stok','{"en":"Max stock"}','Stok ve planlama',60,'sayi',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','yeniden_siparis_noktasi','Yeniden sipariş noktası','{"en":"Reorder point"}','Stok ve planlama',70,'sayi',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','fantom','Fantom (stoklanmaz)','{"en":"Phantom"}','Stok ve planlama',80,'evet_hayir',NULL,'ozellik',false,NULL,NULL,'Ağaçta görünür, stoğa girmez; bileşenleri doğrudan üst kaleme tüketilir.'),
  ('cekirdek.kalem','parti_buyuklugu','Parti büyüklüğü','{"en":"Batch size"}','Üretim',20,'sayi',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','hazir_alinir','Hazır alınır','{"en":"Purchased"}','Üretim',30,'evet_hayir',NULL,'ozellik',true,NULL,NULL,NULL),
  ('cekirdek.kalem','uretim_notu','Üretim notu','{"en":"Production note"}','Üretim',40,'uzun_metin',NULL,'ozellik',true,NULL,NULL,NULL),
  ('cekirdek.kalem','son_alis_fiyati','Son alış fiyatı','{"en":"Last purchase price"}','Satın alma',10,'para',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','asgari_siparis','Asgari sipariş (MOQ)','{"en":"MOQ"}','Satın alma',20,'sayi',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','gtip','GTİP','{"en":"HS code"}','Satın alma',30,'metin',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','mense','Menşe','{"en":"Origin"}','Satın alma',40,'metin',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','raf_omru_gun','Raf ömrü','{"en":"Shelf life"}','Kalite ve izlenebilirlik',30,'tamsayi',NULL,'ozellik',false,'gun',0,NULL),
  ('cekirdek.kalem','giris_muayenesi','Giriş muayenesi gerekli','{"en":"Incoming inspection"}','Kalite ve izlenebilirlik',40,'evet_hayir',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','standart_maliyet','Standart maliyet','{"en":"Standard cost"}','Maliyet ve muhasebe',10,'para',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','maliyet_yontemi','Maliyet yöntemi','{"en":"Costing method"}','Maliyet ve muhasebe',20,'liste','[{"deger":"fifo","etiket":"FIFO"},{"deger":"ortalama","etiket":"Ağırlıklı ortalama"},{"deger":"standart","etiket":"Standart"}]','ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','kdv_orani','KDV oranı','{"en":"VAT rate"}','Maliyet ve muhasebe',30,'sayi',NULL,'ozellik',false,'%',0,NULL),
  ('cekirdek.kalem','muhasebe_kodu','Muhasebe hesap kodu','{"en":"Account code"}','Maliyet ve muhasebe',40,'metin',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','satis_fiyati','Satış fiyatı','{"en":"Sales price"}','Maliyet ve muhasebe',50,'para',NULL,'ozellik',false,NULL,0,NULL),
  ('cekirdek.kalem','gorsel','Görsel','{"en":"Image"}','Doküman',10,'dosya',NULL,'ozellik',false,NULL,NULL,NULL),
  ('cekirdek.kalem','teknik_resim','Teknik resim','{"en":"Drawing"}','Doküman',20,'dosya',NULL,'ozellik',false,NULL,NULL,NULL);

-- Maliyet alanlari operatore kapali (alan duzeyinde yetki ornegi; ekran bu listeyi uygular).
UPDATE sistem.alan_tanim SET gorme_rolleri = ARRAY['yonetici','planlama','satinalma','muhasebe']
WHERE varlik = 'cekirdek.kalem' AND grup = 'Maliyet ve muhasebe';

-- ALAN KATALOGU: PARTNER --------------------------------------------------------
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, secenekler, depolama, sistem_alani, gorunur, zorunlu, birim, aciklama) VALUES
  ('cekirdek.partner','kod','Kod','{"en":"Code"}','Kimlik',10,'metin',NULL,'kolon',true,true,true,NULL,NULL),
  ('cekirdek.partner','ad','Unvan','{"en":"Name"}','Kimlik',20,'metin',NULL,'kolon',true,true,true,NULL,NULL),
  ('cekirdek.partner','vergi_no','Vergi no','{"en":"Tax no"}','Kimlik',30,'metin',NULL,'kolon',false,true,false,NULL,NULL),
  ('cekirdek.partner','vergi_dairesi','Vergi dairesi','{"en":"Tax office"}','Kimlik',40,'metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','adres','Adres','{"en":"Address"}','İletişim',10,'uzun_metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','il','İl','{"en":"City"}','İletişim',20,'metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','ulke','Ülke','{"en":"Country"}','İletişim',30,'metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','telefon','Telefon','{"en":"Phone"}','İletişim',40,'metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','eposta','E-posta','{"en":"Email"}','İletişim',50,'metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','yetkili','Yetkili kişi','{"en":"Contact"}','İletişim',60,'metin',NULL,'ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','para_birimi','Para birimi','{"en":"Currency"}','Ticari',10,'liste','[{"deger":"TRY","etiket":"TRY"},{"deger":"EUR","etiket":"EUR"},{"deger":"USD","etiket":"USD"},{"deger":"GBP","etiket":"GBP"}]','ozellik',false,true,false,NULL,NULL),
  ('cekirdek.partner','odeme_vadesi_gun','Ödeme vadesi','{"en":"Payment terms"}','Ticari',20,'tamsayi',NULL,'ozellik',false,true,false,'gun',NULL),
  ('cekirdek.partner','kredi_limiti','Kredi limiti','{"en":"Credit limit"}','Ticari',30,'para',NULL,'ozellik',false,false,false,NULL,NULL),
  ('cekirdek.partner','teslim_sekli','Teslim şekli','{"en":"Incoterm"}','Ticari',40,'liste','[{"deger":"EXW","etiket":"EXW"},{"deger":"FCA","etiket":"FCA"},{"deger":"DAP","etiket":"DAP"},{"deger":"DDP","etiket":"DDP"},{"deger":"FOB","etiket":"FOB"},{"deger":"CIF","etiket":"CIF"}]','ozellik',false,false,false,NULL,NULL),
  ('cekirdek.partner','kalite_onayli','Kalite onaylı tedarikçi','{"en":"Approved supplier"}','Kalite',10,'evet_hayir',NULL,'ozellik',false,false,false,NULL,NULL);

-- ALAN KATALOGU: IS MERKEZI ve KAYNAK --------------------------------------------
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, depolama, sistem_alani, gorunur, zorunlu, birim) VALUES
  ('cekirdek.is_merkezi','kod','Kod','{"en":"Code"}','Kimlik',10,'metin','kolon',true,true,true,NULL),
  ('cekirdek.is_merkezi','ad','Ad','{"en":"Name"}','Kimlik',20,'metin','kolon',true,true,true,NULL),
  ('cekirdek.is_merkezi','saat_maliyeti','Saat maliyeti','{"en":"Hourly cost"}','Maliyet',10,'para','kolon',false,true,false,NULL),
  ('cekirdek.is_merkezi','gunluk_kapasite_saat','Günlük kapasite','{"en":"Daily capacity"}','Kapasite',10,'sayi','kolon',false,true,false,'saat'),
  ('cekirdek.is_merkezi','paralel_kaynak','Paralel kaynak','{"en":"Parallel resources"}','Kapasite',20,'tamsayi','kolon',false,true,false,NULL),
  ('cekirdek.is_merkezi','bolum','Bölüm','{"en":"Department"}','Kimlik',30,'metin','ozellik',false,true,false,NULL),
  ('cekirdek.is_merkezi','oee_hedefi','OEE hedefi','{"en":"OEE target"}','Kapasite',30,'sayi','ozellik',false,false,false,'%'),
  ('cekirdek.kaynak','kod','Kod / sicil','{"en":"Code"}','Kimlik',10,'metin','kolon',true,true,true,NULL),
  ('cekirdek.kaynak','ad','Ad','{"en":"Name"}','Kimlik',20,'metin','kolon',true,true,true,NULL),
  ('cekirdek.kaynak','saat_maliyeti','Saat maliyeti','{"en":"Hourly cost"}','Maliyet',10,'para','kolon',false,false,false,NULL),
  ('cekirdek.kaynak','ise_giris','İşe giriş','{"en":"Start date"}','Kimlik',30,'tarih','ozellik',false,false,false,NULL),
  ('cekirdek.kaynak','marka_model','Marka / model','{"en":"Make / model"}','Makine',10,'metin','ozellik',false,false,false,NULL),
  ('cekirdek.kaynak','bakim_periyodu_gun','Bakım periyodu','{"en":"Maintenance interval"}','Makine',20,'tamsayi','ozellik',false,false,false,'gun');
`,L=`-- 0008 · CANLI DEDEKTOR MOTORU (ilke 5: canli ya da acikca bayat — burada hep canli)
--
-- Eski UYS'de dedektor sayilari bir onbellege yaziliyor, cron ile tazeleniyordu: tasarim geregi
-- geriden geliyordu ("dedektorler bayat bilgi veriyor"). Burada:
--
--   * Dedektor = KAYIT: ad, onem, aciklama, SQL sorgusu, BAGIMLILIK listesi.
--   * Bagimli tablolardan birinde satir degisince, etkilenen kayitlar AYNI ISLEM (transaction)
--     icinde yeniden denetlenir. Islem commit oldugunda bulgular zaten guncel; ara donem yok.
--   * Bulgu kayit bazlidir: (dedektor, kayit) basina tek acik bulgu. Duzelen kayidin bulgusu
--     kendiliginden KAPANIR (silinmez; ne zaman acildi / kapandi gecmisi durur).
--   * Toplam sayi onbellek degil, acik bulgularin sayimidir.
--   * Dedektor yalniz BILDIRIR, veriye dokunmaz (ilke 8: tahmin asla yazilmaz).
--
-- sistem.bulgu turetilmis veridir (ilke 1'in bilincli istisnasi): hizli sayim ve acilis/kapanis
-- gecmisi icin saklanir, AMA bayat kalamaz — her bagimlilik degisikliginde ayni islemde yenilenir.
--
-- Sorgu sozlesmesi:
--   $1 = text[] denetlenecek kayit kimlikleri, NULL = hepsi.
--   Donus kolonlari: kayit_id text, mesaj text, ayrinti jsonb. Kayit basina EN FAZLA bir satir.
-- Bagimlilik bicimi (jsonb dizi):
--   {"tablo":"cekirdek.kalem","kayit":"id"}                     degisen satirin kolonu = kayit kimligi
--   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT ..."}   $1 = degisen satir (jsonb) -> kayit kimlikleri

CREATE TABLE sistem.dedektor (
  kod          text PRIMARY KEY CHECK (kod ~ '^D-[A-Z0-9]+(-[A-Z0-9]+)*$'),
  ad           text NOT NULL,
  varlik       text NOT NULL,
  onem         text NOT NULL CHECK (onem IN ('kritik','uyari','bilgi')),
  aciklama     text NOT NULL CHECK (length(aciklama) >= 10),
  cozum        text,                      -- kullaniciya "ne yapmali"
  sorgu        text NOT NULL,
  bagimlilik   jsonb NOT NULL CHECK (jsonb_typeof(bagimlilik) = 'array' AND jsonb_array_length(bagimlilik) > 0),
  kural_kod    text REFERENCES sistem.kural(kod),
  aktif        boolean NOT NULL DEFAULT true,
  olusturma    timestamptz NOT NULL DEFAULT now(),
  guncelleme   timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('sistem.dedektor', 'kod');
-- Dedektor sorgusu motor yetkisiyle (SECURITY DEFINER) calisir: kayit YALNIZ yonetici/kurulum
-- rolunce yazilir. Giris yapmis kullanici okur, yazamaz.
REVOKE INSERT, UPDATE, DELETE ON sistem.dedektor FROM authenticated;

CREATE TABLE sistem.bulgu (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  dedektor_kod  text NOT NULL REFERENCES sistem.dedektor(kod) ON DELETE CASCADE,
  varlik        text NOT NULL,
  kayit_id      text NOT NULL,
  mesaj         text NOT NULL,
  ayrinti       jsonb NOT NULL DEFAULT '{}',
  durum         text NOT NULL DEFAULT 'acik' CHECK (durum IN ('acik','kapandi')),
  ilk_gorulme   timestamptz NOT NULL DEFAULT clock_timestamp(),
  son_gorulme   timestamptz NOT NULL DEFAULT clock_timestamp(),
  kapanma       timestamptz,
  CHECK ((durum = 'kapandi') = (kapanma IS NOT NULL))
);
CREATE UNIQUE INDEX bulgu_tek_acik ON sistem.bulgu (dedektor_kod, kayit_id) WHERE durum = 'acik';
CREATE INDEX bulgu_kayit ON sistem.bulgu (varlik, kayit_id) WHERE durum = 'acik';
ALTER TABLE sistem.bulgu ENABLE ROW LEVEL SECURITY;
CREATE POLICY firma_kullanicisi ON sistem.bulgu TO authenticated USING (true);
REVOKE ALL ON sistem.bulgu FROM anon;
GRANT SELECT ON sistem.bulgu TO authenticated;      -- yalniz motor yazar

-- Islem ici kuyruk: satir tetikleyicisi isaretler, ifade tetikleyicisi isler.
CREATE TABLE sistem.dedektor_kuyruk (
  islem_id      bigint NOT NULL DEFAULT txid_current(),
  dedektor_kod  text NOT NULL,
  kayit_id      text NOT NULL,
  PRIMARY KEY (islem_id, dedektor_kod, kayit_id)
);
ALTER TABLE sistem.dedektor_kuyruk ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sistem.dedektor_kuyruk FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- CALISTIRICI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.dedektor_calistir(p_kod text, p_kayitlar text[] DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, public, pg_temp AS $$
DECLARE
  d        sistem.dedektor;
  v_sonuc  jsonb;
  v_satir  jsonb;
  v_tekrar text;
  v_acik   int;
BEGIN
  SELECT * INTO d FROM sistem.dedektor WHERE kod = p_kod;
  IF d.kod IS NULL THEN RAISE EXCEPTION 'Dedektor yok: %', p_kod; END IF;
  IF NOT d.aktif THEN RETURN 0; END IF;

  BEGIN
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(jsonb_build_object(''kayit_id'', q.kayit_id::text, ''mesaj'', q.mesaj::text, ''ayrinti'', COALESCE(q.ayrinti::jsonb, ''{}''))), ''[]'') FROM (%s) q',
      d.sorgu) INTO v_sonuc USING p_kayitlar;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Dedektor % sorgusu calismadi: %', p_kod, SQLERRM USING ERRCODE = SQLSTATE;
  END;

  SELECT k INTO v_tekrar FROM jsonb_array_elements(v_sonuc) e, LATERAL (SELECT e ->> 'kayit_id' AS k) x
  GROUP BY k HAVING count(*) > 1 LIMIT 1;
  IF v_tekrar IS NOT NULL THEN
    RAISE EXCEPTION 'Dedektor % ayni kayit icin birden fazla satir dondurdu (%). Kayit basina tek satir olmali; mesajlari birlestirin.', p_kod, v_tekrar;
  END IF;

  FOR v_satir IN SELECT * FROM jsonb_array_elements(v_sonuc) LOOP
    UPDATE sistem.bulgu SET mesaj = v_satir ->> 'mesaj', ayrinti = v_satir -> 'ayrinti', son_gorulme = clock_timestamp()
    WHERE dedektor_kod = p_kod AND kayit_id = v_satir ->> 'kayit_id' AND durum = 'acik';
    IF NOT FOUND THEN
      INSERT INTO sistem.bulgu (dedektor_kod, varlik, kayit_id, mesaj, ayrinti)
      VALUES (p_kod, d.varlik, v_satir ->> 'kayit_id', v_satir ->> 'mesaj', v_satir -> 'ayrinti');
    END IF;
  END LOOP;

  UPDATE sistem.bulgu SET durum = 'kapandi', kapanma = clock_timestamp()
  WHERE dedektor_kod = p_kod AND durum = 'acik'
    AND (p_kayitlar IS NULL OR kayit_id = ANY (p_kayitlar))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sonuc) e WHERE e ->> 'kayit_id' = sistem.bulgu.kayit_id);

  SELECT count(*) INTO v_acik FROM sistem.bulgu WHERE dedektor_kod = p_kod AND durum = 'acik';
  RETURN v_acik;
END $$;

-- Satir degisti -> etkilenen (dedektor, kayit) ciftlerini kuyruga yaz.
CREATE OR REPLACE FUNCTION sistem.dedektor_isaretle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, public, pg_temp AS $$
DECLARE
  v_tablo text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  r       record;
  v_satir jsonb;
  v_id    text;
BEGIN
  FOR r IN
    SELECT d.kod, b AS bag FROM sistem.dedektor d, jsonb_array_elements(d.bagimlilik) b
    WHERE d.aktif AND b ->> 'tablo' = v_tablo
  LOOP
    FOREACH v_satir IN ARRAY ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
                                   CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END] LOOP
      CONTINUE WHEN v_satir IS NULL;
      IF r.bag ? 'kayit' THEN
        v_id := v_satir ->> (r.bag ->> 'kayit');
        IF v_id IS NOT NULL THEN
          INSERT INTO sistem.dedektor_kuyruk (dedektor_kod, kayit_id) VALUES (r.kod, v_id) ON CONFLICT DO NOTHING;
        END IF;
      ELSE
        FOR v_id IN EXECUTE (r.bag ->> 'sorgu') USING v_satir LOOP
          CONTINUE WHEN v_id IS NULL;
          INSERT INTO sistem.dedektor_kuyruk (dedektor_kod, kayit_id) VALUES (r.kod, v_id) ON CONFLICT DO NOTHING;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

-- Ifade bitti -> kuyruktaki kayitlari denetle. Islem icinde; commit'te bulgular guncel.
CREATE OR REPLACE FUNCTION sistem.dedektor_kuyrugu_isle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT dedektor_kod, array_agg(kayit_id ORDER BY kayit_id) AS kayitlar
    FROM sistem.dedektor_kuyruk WHERE islem_id = txid_current()
    GROUP BY dedektor_kod ORDER BY dedektor_kod
  LOOP
    DELETE FROM sistem.dedektor_kuyruk WHERE islem_id = txid_current() AND dedektor_kod = r.dedektor_kod;
    PERFORM sistem.dedektor_calistir(r.dedektor_kod, r.kayitlar);
  END LOOP;
  RETURN NULL;
END $$;

-- Bagimli tabloya iki tetikleyiciyi baglar (bir kez; tekrar cagrilirsa yeniler).
CREATE OR REPLACE FUNCTION sistem.dedektor_tabloya_baglan(p_tablo regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_isaretle ON %s', p_tablo);
  EXECUTE format('CREATE TRIGGER zy_dedektor_isaretle AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION sistem.dedektor_isaretle()', p_tablo);
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_isle ON %s', p_tablo);
  EXECUTE format('CREATE TRIGGER zy_dedektor_isle AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION sistem.dedektor_kuyrugu_isle()', p_tablo);
END $$;

-- Dedektor eklenince/degisince: yapiyi dogrula, tablolara baglan, TAMAMINI tara.
-- Sorgu hataliysa kayit reddedilir (islem geri alinir).
CREATE OR REPLACE FUNCTION sistem.dedektor_kaydi()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, public, pg_temp AS $$
DECLARE
  b jsonb;
BEGIN
  IF to_regclass(NEW.varlik) IS NULL THEN
    RAISE EXCEPTION 'Dedektor %: varlik % tablosu yok.', NEW.kod, NEW.varlik USING ERRCODE = 'check_violation';
  END IF;
  -- Dedektor yalniz OKUR: tek ifade, SELECT ya da WITH.
  IF NEW.sorgu !~* '^\\s*(SELECT|WITH)\\s' OR position(';' IN NEW.sorgu) > 0 THEN
    RAISE EXCEPTION 'Dedektor %: sorgu tek bir SELECT/WITH ifadesi olmali (noktali virgul yok).', NEW.kod USING ERRCODE = 'check_violation';
  END IF;
  FOR b IN SELECT * FROM jsonb_array_elements(NEW.bagimlilik) LOOP
    IF to_regclass(b ->> 'tablo') IS NULL THEN
      RAISE EXCEPTION 'Dedektor %: bagimlilik tablosu % yok.', NEW.kod, b ->> 'tablo' USING ERRCODE = 'check_violation';
    END IF;
    IF b ? 'sorgu' AND ((b ->> 'sorgu') !~* '^\\s*(SELECT|WITH)\\s' OR position(';' IN (b ->> 'sorgu')) > 0) THEN
      RAISE EXCEPTION 'Dedektor %: bagimlilik sorgusu tek bir SELECT/WITH ifadesi olmali.', NEW.kod USING ERRCODE = 'check_violation';
    END IF;
    IF (b ? 'kayit') = (b ? 'sorgu') THEN
      RAISE EXCEPTION 'Dedektor %: bagimlilik % icin "kayit" YA DA "sorgu" verilmeli (ikisi birden degil).', NEW.kod, b ->> 'tablo'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM sistem.dedektor_tabloya_baglan((b ->> 'tablo')::regclass);
  END LOOP;
  IF NEW.aktif THEN
    PERFORM sistem.dedektor_calistir(NEW.kod, NULL);
  ELSE
    UPDATE sistem.bulgu SET durum = 'kapandi', kapanma = clock_timestamp() WHERE dedektor_kod = NEW.kod AND durum = 'acik';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER c_dedektor_kaydi AFTER INSERT OR UPDATE ON sistem.dedektor
FOR EACH ROW EXECUTE FUNCTION sistem.dedektor_kaydi();

-- ---------------------------------------------------------------------------
-- OKUMA
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW sistem.dedektor_ozeti AS
SELECT d.kod, d.ad, d.varlik, d.onem, d.aktif, d.aciklama, d.cozum, d.kural_kod,
       (SELECT count(*) FROM sistem.bulgu b WHERE b.dedektor_kod = d.kod AND b.durum = 'acik') AS acik_bulgu,
       (SELECT max(GREATEST(b.son_gorulme, COALESCE(b.kapanma, b.son_gorulme))) FROM sistem.bulgu b WHERE b.dedektor_kod = d.kod) AS son_degisim
FROM sistem.dedektor d;
GRANT SELECT ON sistem.dedektor_ozeti TO authenticated;

-- Kart ustu rozetler: bir kaydin acik bulgulari.
CREATE OR REPLACE FUNCTION sistem.kayit_bulgulari(p_varlik text, p_kayit_id text)
RETURNS TABLE (dedektor_kod text, ad text, onem text, mesaj text, cozum text, ayrinti jsonb, ilk_gorulme timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT b.dedektor_kod, d.ad, d.onem, b.mesaj, d.cozum, b.ayrinti, b.ilk_gorulme
  FROM sistem.bulgu b JOIN sistem.dedektor d ON d.kod = b.dedektor_kod
  WHERE b.varlik = p_varlik AND b.kayit_id = p_kayit_id AND b.durum = 'acik'
  ORDER BY CASE d.onem WHEN 'kritik' THEN 1 WHEN 'uyari' THEN 2 ELSE 3 END, b.dedektor_kod
$$;

-- Kural ozeti artik dedektorleri de "kullanan" olarak gosterir.
CREATE OR REPLACE VIEW sistem.kural_ozeti AS
SELECT k.kod, k.ad, k.tur, k.varlik, k.durum, k.aciklama, k.tanim,
       jsonb_array_length(k.ornekler) AS ornek_sayisi,
       k.kaynak, k.guncelleme,
       ARRAY(
         SELECT n.nspname || '.' || p.proname || '()'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('sistem','cekirdek') AND p.prosrc LIKE '%' || k.kod || '%'
         UNION
         SELECT n.nspname || '.' || c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('v','m') AND n.nspname IN ('sistem','cekirdek')
           AND c.relname <> 'kural_ozeti'
           AND pg_get_viewdef(c.oid) LIKE '%' || k.kod || '%'
         UNION
         SELECT 'dedektor:' || d.kod FROM sistem.dedektor d WHERE d.kural_kod = k.kod OR d.sorgu LIKE '%' || k.kod || '%'
         ORDER BY 1
       ) AS kullanan
FROM sistem.kural k;

-- ---------------------------------------------------------------------------
-- CEKIRDEK DEDEKTORLER (her firmada gecerli)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cekirdek.donusum_var_mi(p_kalem_id uuid, p_kaynak text, p_hedef text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM cekirdek.miktar_cevir(p_kalem_id, 1, p_kaynak, p_hedef);
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

SELECT sistem.baglam_kur('kurulum', NULL, '0008_canli_dedektor', 'cekirdek dedektorler');

INSERT INTO sistem.dedektor (kod, ad, varlik, onem, aciklama, cozum, sorgu, bagimlilik) VALUES
('D-AGAC-BIRIM-DONUSUMU', 'Ürün ağacında birim dönüştürülemiyor', 'cekirdek.kalem', 'kritik',
 'Ağaç satırındaki birim, bileşenin stok birimine dönüştürülemiyor. MRP bu kalemde durur.',
 'Bileşen kartına birim dönüşümü ekleyin ya da satırın birimini düzeltin.',
 $q$SELECT a.kalem_id::text AS kayit_id,
          string_agg(format('%s: %s → %s dönüşümü yok', b.kod, s.birim, b.stok_birimi), ' · ' ORDER BY s.sira) AS mesaj,
          jsonb_build_object('satirlar', jsonb_agg(s.id ORDER BY s.sira)) AS ayrinti
   FROM cekirdek.urun_agaci_satir s
   JOIN cekirdek.urun_agaci a ON a.id = s.agac_id AND a.durum <> 'emekli'
   JOIN cekirdek.kalem b ON b.id = s.bilesen_kalem_id
   WHERE ($1::text[] IS NULL OR a.kalem_id::text = ANY ($1))
     AND NOT cekirdek.donusum_var_mi(b.id, s.birim, b.stok_birimi)
   GROUP BY a.kalem_id$q$,
 $b$[
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT kalem_id::text FROM cekirdek.urun_agaci WHERE id = ($1->>'agac_id')::uuid"},
   {"tablo":"cekirdek.kalem_birim","sorgu":"SELECT a.kalem_id::text FROM cekirdek.urun_agaci_satir s JOIN cekirdek.urun_agaci a ON a.id = s.agac_id WHERE s.bilesen_kalem_id = ($1->>'kalem_id')::uuid"},
   {"tablo":"cekirdek.kalem","sorgu":"SELECT a.kalem_id::text FROM cekirdek.urun_agaci_satir s JOIN cekirdek.urun_agaci a ON a.id = s.agac_id WHERE s.bilesen_kalem_id = ($1->>'id')::uuid"}
 ]$b$),

('D-URETILEN-AGACSIZ', 'Üretilen kalemin aktif ağacı yok', 'cekirdek.kalem', 'uyari',
 'Mamul ya da yarı mamul üretiliyor görünüyor ama aktif ürün ağacı yok. MRP bileşen ihtiyacını hesaplayamaz.',
 'Aktif ürün ağacı tanımlayın ya da kalemi "hazır alınır" işaretleyin.',
 $q$SELECT k.id::text AS kayit_id,
          format('%s (%s) için aktif ürün ağacı yok', k.kod, k.tip) AS mesaj,
          '{}'::jsonb AS ayrinti
   FROM cekirdek.kalem k
   WHERE ($1::text[] IS NULL OR k.id::text = ANY ($1))
     AND k.aktif AND k.tip IN ('mamul','yari_mamul')
     AND COALESCE((k.ozellik ->> 'hazir_alinir')::boolean, false) = false
     AND COALESCE((k.ozellik ->> 'fantom')::boolean, false) = false
     AND NOT EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif')$q$,
 $b$[
   {"tablo":"cekirdek.kalem","kayit":"id"},
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"}
 ]$b$),

('D-KALEM-KOD-SABLONU', 'Kalem kodu firma kod şablonuna uymuyor', 'cekirdek.kalem', 'uyari',
 'Kalem kodu, kural sözlüğündeki aktif kod şablonunun hiçbir desenine uymuyor. Kardeş, varyant ve kök hesapları bu kodda çalışmaz.',
 'Kodu şablona uygun düzeltin ya da şablona yeni desen ekleyin (kural örnekleriyle birlikte).',
 $q$SELECT k.id::text AS kayit_id,
          format('"%s" kod şablonuna uymuyor', k.kod) AS mesaj,
          '{}'::jsonb AS ayrinti
   FROM cekirdek.kalem k
   WHERE ($1::text[] IS NULL OR k.id::text = ANY ($1))
     AND EXISTS (SELECT 1 FROM sistem.kural r WHERE r.kod = 'K-KOD-SABLON' AND r.durum = 'aktif')
     AND sistem.kod_coz(k.kod, 'K-KOD-SABLON') IS NULL$q$,
 $b$[
   {"tablo":"cekirdek.kalem","kayit":"id"},
   {"tablo":"sistem.kural","sorgu":"SELECT id::text FROM cekirdek.kalem WHERE $1->>'kod' = 'K-KOD-SABLON'"}
 ]$b$);
`,T=`-- 0009 · ETKI ANALIZI (ilke 9: degisiklikten ONCE etki)
--
-- "Bir yeri duzeltirken bir yer bozulmasin." Kaydetmeden once ekran sorar:
--   "Bu kalemi degistirirsen: 14 agac satiri, 3 acik uretim emri satiri, 2 stok hareketi,
--    1 acik bulgu ve 3 dedektor etkilenir."
--
-- Elle yazilmis bir liste DEGIL: yapidan otomatik cikar. Yeni tablo FK ile baglandiginda
-- etki analizine kendiliginden girer; unutulma ihtimali yok.
--   1) Yabanci anahtarla bu kayda bakan her tablo (satir sayisiyla)
--   2) Alan katalogunda "iliski" turunde bu tabloya bakan ozellik alanlari (satir sayisiyla)
--   3) Kaydin acik bulgulari
--   4) Bu tablo degisince yeniden kosan dedektorler

CREATE OR REPLACE FUNCTION sistem.etki_analizi(p_tablo regclass, p_kayit_id text)
RETURNS TABLE (tur text, nesne text, sayi bigint, aciklama text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = sistem, cekirdek, public, pg_temp AS $$
DECLARE
  v_varlik text;
  r record;
  v_sayi bigint;
BEGIN
  SELECT n.nspname || '.' || c.relname INTO v_varlik
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_tablo;

  -- 1) Yabanci anahtar referanslari (tek kolonlu FK'ler)
  FOR r IN
    SELECT cn.nspname || '.' || cc.relname AS tablo, a.attname AS kolon, con.conname
    FROM pg_constraint con
    JOIN pg_class cc ON cc.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = cc.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND con.confrelid = p_tablo AND array_length(con.conkey, 1) = 1
      AND cn.nspname IN ('sistem','cekirdek')
    ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I::text = $1', r.tablo, r.kolon) INTO v_sayi USING p_kayit_id;
    IF v_sayi > 0 THEN
      tur := 'baglanti'; nesne := r.tablo || '.' || r.kolon; sayi := v_sayi;
      aciklama := format('%s satir bu kayda bagli', v_sayi);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- 2) Katalogdaki iliski turu ozellik alanlari
  FOR r IN
    SELECT varlik, alan_kodu, etiket FROM sistem.alan_tanim
    WHERE tip = 'iliski' AND depolama = 'ozellik' AND iliski_varlik = v_varlik
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE ozellik ->> %L = $1', r.varlik, r.alan_kodu) INTO v_sayi USING p_kayit_id;
    IF v_sayi > 0 THEN
      tur := 'ozellik_iliskisi'; nesne := r.varlik || '.ozellik.' || r.alan_kodu; sayi := v_sayi;
      aciklama := format('"%s" alaninda %s kayit bu kaydi gosteriyor', r.etiket, v_sayi);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- 3) Acik bulgular
  FOR r IN
    SELECT b.dedektor_kod, b.mesaj FROM sistem.bulgu b
    WHERE b.varlik = v_varlik AND b.kayit_id = p_kayit_id AND b.durum = 'acik' ORDER BY b.dedektor_kod
  LOOP
    tur := 'acik_bulgu'; nesne := r.dedektor_kod; sayi := 1; aciklama := r.mesaj;
    RETURN NEXT;
  END LOOP;

  -- 4) Bu tablo degisince yeniden kosan dedektorler
  FOR r IN
    SELECT DISTINCT d.kod, d.ad FROM sistem.dedektor d, jsonb_array_elements(d.bagimlilik) b
    WHERE d.aktif AND b ->> 'tablo' = v_varlik ORDER BY d.kod
  LOOP
    tur := 'dedektor'; nesne := r.kod; sayi := NULL; aciklama := r.ad;
    RETURN NEXT;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION sistem.etki_analizi(regclass, text) TO authenticated;
`,c=`-- 0010 · OLAY DEFTERI YETKI DUZELTMESI
--
-- HATA (0002'den beri, 0008 testi yakaladi): sistem.olay_izle tetikleyicisi cagiranin yetkisiyle
-- calisiyordu. Giris yapmis kullanicinin (authenticated) sistem.olay'a yalniz SELECT yetkisi var
-- -> kullanici HERHANGI bir kaydi yazdiginda "permission denied for table olay". Uretimde hic
-- kimse hicbir sey kaydedemezdi. Onceki guvenlik testi okumayi ve yasak islemi denetliyordu,
-- basarili bir yazmayi kullanici roluyle hic denemiyordu.
--
-- COZUM: defteri yalniz tetikleyici, MOTOR yetkisiyle yazar. Kullanici deftere dogrudan yazamaz
-- (INSERT yetkisi yok) ama yaptigi her degisiklik deftere duser. "kullanici" bilgisi baglamdan
-- (x-uretim-* basligi / auth.uid()) gelir, tetikleyicinin sahibinden degil.
--
-- Uygulanmis 0002 degistirilmedi (kural: gecmis yeniden yazilmaz); duzeltme bu dosyadir.

ALTER FUNCTION sistem.olay_izle() SECURITY DEFINER SET search_path = sistem, cekirdek, public, pg_temp;

-- Kullanici defteri okur ama elle satir ekleyemez (sahte gecmis yazilamaz).
REVOKE INSERT, UPDATE, DELETE ON sistem.olay FROM authenticated;
GRANT SELECT ON sistem.olay TO authenticated;
`,g=`-- 0011 · KOYU TEMA VARSAYILAN CIZGI KONTRASTI
--
-- 0007'deki koyu mod "cizgi" varsayilani (#3a4552) zemin (#12161b) uzerinde 1,86:1 idi; arayuzun
-- kontrast kurali kilavuz cizgisi icin en az 3:1 ister (packages/arayuz KONTRAST_CIFTLERI).
-- Sonuc: koyu modda tema ayar ekrani HICBIR kaydi kabul etmiyordu (varsayilan zaten "okunmaz").
-- Ilk kez apps/uretim tema ekraninda goruldu (15 Eyl 2026). Uygulanmis 0007 degistirilmez; duzeltme burada.
--   cizgi       #3a4552 (1,86:1) -> #5b6775 (3,15:1)
--   cizgi-guclu #56626f (2,92:1) -> #6f7c8a  (dis cerceve kilavuz cizgisinden belirgin kalsin)
-- Kullanici/firma temasinda bu tokenlari ezen deger varsa dokunulmaz (yalniz varsayilan).

SELECT sistem.baglam_kur('kurulum', NULL, '0011_koyu_tema_cizgi_kontrasti', 'koyu varsayilan cizgi 3:1 alti');

UPDATE sistem.tema_token SET varsayilan_koyu = '#5b6775' WHERE ad = 'cizgi' AND varsayilan_koyu = '#3a4552';
UPDATE sistem.tema_token SET varsayilan_koyu = '#6f7c8a' WHERE ad = 'cizgi-guclu' AND varsayilan_koyu = '#56626f';
`,R=`-- 0012 · KATALOG KAPSAMI: zorunlu kolonlar katalogda olmali
--
-- Kurulum sihirbazi Excel sablonunu ve ice aktarimi ALAN KATALOGUNDAN uretir (ilke 12: kurulum =
-- gunluk ice aktarim). Varsayilani olmayan NOT NULL bir kolon katalogda yoksa sablonda sutunu olmaz
-- ve o varlik hic aktarilamaz. Olcum (15 Eyl 2026): partner.roller ve kaynak.tur eksikti.
-- tests/katalog_kapsami.test.js bu boslugun yeniden acilmasini engeller.

SELECT sistem.baglam_kur('kurulum', NULL, '0012_katalog_zorunlu_kolonlar', 'zorunlu kolonlar kataloga');

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, secenekler, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu) VALUES
  ('cekirdek.partner', 'roller', 'Roller', '{"en":"Roles"}', 'Kimlik', 25, 'coklu_liste',
   '[{"deger":"musteri","etiket":"Müşteri"},{"deger":"tedarikci","etiket":"Tedarikçi"},{"deger":"fasoncu","etiket":"Fasoncu"}]',
   NULL, 'kolon', true, true, true),
  ('cekirdek.kaynak', 'tur', 'Tür', '{"en":"Type"}', 'Kimlik', 25, 'liste',
   '[{"deger":"operator","etiket":"Operatör"},{"deger":"makine","etiket":"Makine"}]',
   NULL, 'kolon', true, true, true),
  ('cekirdek.kaynak', 'is_merkezi_id', 'İş merkezi', '{"en":"Work center"}', 'Kimlik', 40, 'iliski',
   NULL, 'cekirdek.is_merkezi', 'kolon', false, true, false);
`,A=`-- 0013 · DEDEKTOR SORGULARI INDEKS KULLANSIN
--
-- Olcum (15 Eyl 2026, Ozler hacminde ice aktarim denemesi): 8.081 yeni kalem satir satir 106 sn.
-- Kalem ekleme maliyeti dedektorsuz 0,91 ms, dedektorlu 5,79 ms (3.000 kalemde; tablo buyudukce artar).
-- Kok: 0008'deki cekirdek dedektorler kayit suzgecini "k.id::text = ANY ($1)" diye yaziyordu. Kolon
-- metne cevrildigi icin birincil anahtar indeksi yalniz bitmap taramasi olarak, TUM satirlar icin
-- kullaniliyordu: her ifade tetikleyicisi tabloyu bastan tariyordu (satir basina O(n) -> aktarimda O(n²)).
-- Duzeltme: dizi uuid'e cevrilir, kolon cevrilmez. Sozlesme ($1 = text[]) degismez.
-- Ek: urun_agaci_satir.bilesen_kalem_id indeksi (D-AGAC bagimlilik sorgusu ve etki analizi kalem basina bunu arar).

SELECT sistem.baglam_kur('kurulum', NULL, '0013_dedektor_indeks_kosulu', 'dedektor suzgeci indeks kullansin');

CREATE INDEX IF NOT EXISTS urun_agaci_satir_bilesen ON cekirdek.urun_agaci_satir (bilesen_kalem_id);

DO $$
DECLARE
  r record;
  v_yeni text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('D-URETILEN-AGACSIZ',    'k.id::text = ANY ($1)',       'k.id = ANY ($1::uuid[])'),
      ('D-KALEM-KOD-SABLONU',   'k.id::text = ANY ($1)',       'k.id = ANY ($1::uuid[])'),
      ('D-AGAC-BIRIM-DONUSUMU', 'a.kalem_id::text = ANY ($1)', 'a.kalem_id = ANY ($1::uuid[])')
    ) AS x(kod, eski, yeni)
  LOOP
    SELECT replace(sorgu, r.eski, r.yeni) INTO v_yeni FROM sistem.dedektor WHERE kod = r.kod AND position(r.eski IN sorgu) > 0;
    IF v_yeni IS NULL THEN
      RAISE EXCEPTION '0013: % sorgusunda beklenen suzgec (%) bulunamadi; sorgu 0008 sonrasi degismis.', r.kod, r.eski;
    END IF;
    UPDATE sistem.dedektor SET sorgu = v_yeni WHERE kod = r.kod;
  END LOOP;
END $$;
`,O=`-- 0014 · BAGLAMLI (URUNE OZEL) URUN AGACI
--
-- Olcum (15 Eyl 2026, Ozler PROD receteleri): 2.875 ust dugum kalemin 216'sinin cocuklari urune gore
-- degisiyor (ornek: ayni montaj yari mamulu 22 urunde 9 farkli bilesen listesiyle). Neden: yari mamul
-- kodu jenerik bir URETIM ADIMIDIR; icerigi hangi urun icin yapildigina baglidir. Bu, sektorden
-- bagimsiz bir durumdur (ayni "kaynakli govde" adimi farkli boylarda farkli parca adedi alir).
--
-- Model:
--   baglam_kalem_id NULL  -> GENEL agac: kalem her yerde bu bilesenlerle yapilir.
--   baglam_kalem_id dolu  -> BAGLAMLI agac: kalem, o KOK URUN icin uretilirken bu bilesenlerle yapilir.
-- Cozum sirasi (MRP, cekirdek/mrp.ts): once (kalem, kok urun) agaci, yoksa genel agac.
-- Tek aktif agac ve surum benzersizligi BAGLAM BASINA gecerlidir.

SELECT sistem.baglam_kur('kurulum', NULL, '0014_urun_agaci_baglam', 'urune ozel urun agaci');

ALTER TABLE cekirdek.urun_agaci
  ADD COLUMN baglam_kalem_id uuid REFERENCES cekirdek.kalem(id),
  ADD CONSTRAINT urun_agaci_baglam_kendisi_degil CHECK (baglam_kalem_id IS NULL OR baglam_kalem_id <> kalem_id);

ALTER TABLE cekirdek.urun_agaci DROP CONSTRAINT urun_agaci_kalem_id_surum_key;
CREATE UNIQUE INDEX urun_agaci_surum_tek
  ON cekirdek.urun_agaci (kalem_id, COALESCE(baglam_kalem_id, '00000000-0000-0000-0000-000000000000'::uuid), surum);

DROP INDEX cekirdek.urun_agaci_tek_aktif;
CREATE UNIQUE INDEX urun_agaci_tek_aktif
  ON cekirdek.urun_agaci (kalem_id, COALESCE(baglam_kalem_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE durum = 'aktif';

CREATE INDEX urun_agaci_baglam ON cekirdek.urun_agaci (baglam_kalem_id) WHERE baglam_kalem_id IS NOT NULL;

COMMENT ON COLUMN cekirdek.urun_agaci.baglam_kalem_id IS
  'NULL = genel agac. Dolu = bu agac yalniz bu kok urun icin uretilirken gecerli (cozum: once baglamli, yoksa genel).';
`,I=`-- 0015 · EMIR BAGLAMI ve SATIR KALANI (siparis -> MRP -> emir -> stok -> sevk akisi)
--
-- 1) belge_satir.baglam_kalem_id: urune ozel planlanan bir kalemin (0014) uretim emri HANGI kok urun
--    icin acildi. Tuketimde dogru agac (once o urunun agaci, yoksa genel) ve MRP'de planli girisin
--    dogru plana dusmesi buna baglidir. MRP'nin okudugu alan oldugu icin gercek kolon (ozellik degil).
-- 2) cekirdek.belge_satir_kalan: siparis / emir satirinin ACIK miktari. Tablo degil, hareket defterinden
--    hesaplanir (ilke 1: bir deger tek yerde yasar). Satir miktari stok birimine cekirdek.miktar_cevir ile
--    cevrilir; gerceklesen = satirin kendi hareket turu + onlari duzelten ters kayitlar.

SELECT sistem.baglam_kur('kurulum', NULL, '0015_emir_baglami_ve_satir_kalani', 'emir baglami + satir kalani');

ALTER TABLE cekirdek.belge_satir ADD COLUMN baglam_kalem_id uuid REFERENCES cekirdek.kalem(id);
CREATE INDEX belge_satir_kalem ON cekirdek.belge_satir (kalem_id);

COMMENT ON COLUMN cekirdek.belge_satir.baglam_kalem_id IS
  'Urune gore icerigi degisen ara kalemin emri hangi kok urun icin acildi. Bos = genel.';
-- (Katalog kaydi yok: belge satiri Excel sablonuyla aktarilan bir kart degil; katalog kapsami testi
--  katalogu olan varligin tum zorunlu kolonlarini ister.)

-- Belge turu -> satirin stoga etkisi olan hareket turu ve yonu (+1 giris, -1 cikis)
CREATE OR REPLACE FUNCTION cekirdek.belge_hareket_turu(p_belge_turu text)
RETURNS TABLE (hareket_turu text, yon int) LANGUAGE sql IMMUTABLE AS $$
  SELECT v.ht, v.y FROM (VALUES
    ('satis_siparisi',     'satis_cikis',  -1),
    ('satinalma_siparisi', 'mal_kabul',     1),
    ('uretim_emri',        'uretim_cikti',  1),
    ('fason_emri',         'mal_kabul',     1)
  ) v(bt, ht, y) WHERE v.bt = p_belge_turu
$$;

CREATE OR REPLACE VIEW cekirdek.belge_satir_kalan AS
SELECT s.id AS belge_satir_id, s.belge_id, b.tur AS belge_turu, b.no AS belge_no, b.durum AS belge_durum,
       s.sira, s.kalem_id, k.kod AS kalem_kod, s.baglam_kalem_id, s.termin, s.durum AS satir_durum,
       k.stok_birimi,
       cekirdek.miktar_cevir(s.kalem_id, s.miktar, s.birim, k.stok_birimi) AS miktar,
       COALESCE(g.gerceklesen, 0) AS gerceklesen,
       cekirdek.miktar_cevir(s.kalem_id, s.miktar, s.birim, k.stok_birimi) - COALESCE(g.gerceklesen, 0) AS kalan
FROM cekirdek.belge_satir s
JOIN cekirdek.belge b ON b.id = s.belge_id
JOIN cekirdek.kalem k ON k.id = s.kalem_id
CROSS JOIN LATERAL cekirdek.belge_hareket_turu(b.tur) ht
LEFT JOIN LATERAL (
  SELECT sum(h.miktar * ht.yon) AS gerceklesen
  FROM cekirdek.stok_hareket h
  LEFT JOIN cekirdek.stok_hareket asil ON asil.id = h.ters_hareket_id
  WHERE h.belge_satir_id = s.id
    AND (h.tur = ht.hareket_turu OR (h.tur = 'ters_kayit' AND asil.tur = ht.hareket_turu))
) g ON true;
GRANT SELECT ON cekirdek.belge_satir_kalan TO authenticated;
`,b=`-- 0016 · GERI AL: DEFTER TABLOSUNDA SILME YERINE TERS KAYIT
--
-- Olcum (15 Eyl 2026, uctan uca siparis -> sevk testi): sevk islem grubunu geri almak
--   "Stok hareketi degistirilemez/silinemez. Duzeltme icin ters_kayit hareketi girin."
-- hatasiyla durdu. sistem.islem_geri_al (0002) eklenen satiri SILEREK geri aliyordu; stok hareketi
-- ise yalniz eklenen bir defterdir (0005). Sonuc: stok hareketi iceren HICBIR islem (mal kabul,
-- uretim, sevk, acilis) geri alinamiyordu.
-- Duzeltme: defter niteligindeki tabloda 'ekle' olayi TERS KAYITLA geri alinir (ayni kalem/depo/lot,
-- ters isaretli miktar, ters_hareket_id = asil). Gecmis silinmez; defter ikisini de gosterir.

SELECT sistem.baglam_kur('kurulum', NULL, '0016_geri_al_defter_ters_kayit', 'geri al: defterde ters kayit');

CREATE OR REPLACE FUNCTION cekirdek.stok_hareket_ters_kayit(p_hareket_id uuid, p_aciklama text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  h cekirdek.stok_hareket;
  v_id uuid;
BEGIN
  SELECT * INTO h FROM cekirdek.stok_hareket WHERE id = p_hareket_id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'Stok hareketi bulunamadi: %', p_hareket_id; END IF;
  IF h.tur = 'ters_kayit' THEN
    RAISE EXCEPTION 'Ters kaydin kendisi ters kayitla geri alinmaz; asil hareketi yeniden girin.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO cekirdek.stok_hareket (kalem_id, depo_id, lokasyon_id, lot_id, miktar, tur, belge_satir_id, ters_hareket_id, aciklama)
  VALUES (h.kalem_id, h.depo_id, h.lokasyon_id, h.lot_id, -h.miktar, 'ters_kayit', h.belge_satir_id, h.id, COALESCE(p_aciklama, 'geri alındı'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION sistem.islem_geri_al(p_grup uuid, p_gerekce text DEFAULT NULL, p_zorla boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  o        sistem.olay%ROWTYPE;
  v_yeni_grup uuid;
  v_simdiki jsonb;
  v_sayi   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sistem.olay WHERE islem_grubu = p_grup) THEN
    RAISE EXCEPTION 'Islem grubu bulunamadi: %', p_grup;
  END IF;

  v_yeni_grup := sistem.baglam_kur('geri_al', sistem.baglam('kullanici'), p_grup::text,
                                   COALESCE(p_gerekce, 'islem grubu geri alindi'));

  FOR o IN SELECT * FROM sistem.olay WHERE islem_grubu = p_grup ORDER BY id DESC LOOP
    EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %I::text = $1', o.varlik, o.anahtar_alan)
      INTO v_simdiki USING o.kayit_id;

    IF o.islem = 'ekle' THEN
      IF v_simdiki IS NULL THEN CONTINUE; END IF;
      IF o.varlik = 'cekirdek.stok_hareket' THEN
        -- Defter: silinmez, ters kayitla dengelenir.
        IF EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE ters_hareket_id = o.kayit_id::uuid) THEN
          RAISE EXCEPTION 'Geri alinamaz: stok hareketi % zaten ters kayitla duzeltilmis.', o.kayit_id;
        END IF;
        PERFORM cekirdek.stok_hareket_ters_kayit(o.kayit_id::uuid, 'geri alındı: işlem ' || p_grup::text);
      ELSE
        EXECUTE format('DELETE FROM %s WHERE %I::text = $1', o.varlik, o.anahtar_alan) USING o.kayit_id;
      END IF;

    ELSIF o.islem = 'sil' THEN
      IF v_simdiki IS NOT NULL AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% silindikten sonra yeniden olusturulmus.', o.varlik, o.kayit_id;
      END IF;
      EXECUTE format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, $1)', o.varlik) USING o.eski;

    ELSE -- degistir
      IF v_simdiki IS NULL THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% artik yok.', o.varlik, o.kayit_id;
      END IF;
      IF (v_simdiki -> o.alan) IS DISTINCT FROM o.yeni AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/%.% bu islemden sonra degistirilmis (simdi %, islem %).',
          o.varlik, o.kayit_id, o.alan, v_simdiki -> o.alan, o.yeni;
      END IF;
      EXECUTE format(
        'UPDATE %1$s SET %2$I = (jsonb_populate_record(NULL::%1$s, $1)).%2$I WHERE %3$I::text = $2',
        o.varlik, o.alan, o.anahtar_alan)
        USING jsonb_build_object(o.alan, o.eski), o.kayit_id;
    END IF;
    v_sayi := v_sayi + 1;
  END LOOP;

  RETURN v_yeni_grup;
END $$;
`,S=`-- 0017 · OPERASYON KARTI KATALOGDA (rota ve kapasite icin Excel aktarimi)
--
-- Rota adimi operasyona baglanir; operasyon da role (kesim, montaj, dis_tedarik...) ve varsayilan is
-- merkezine. Firma operasyonlarini sihirbazda Excel'le girebilsin diye kart katalogdadir.
-- Katalog kapsami testi (0012): varsayilansiz zorunlu kolonlarin (kod, ad, rol) hepsi burada.

SELECT sistem.baglam_kur('kurulum', NULL, '0017_operasyon_katalogu', 'operasyon karti katalogu');

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu, aciklama) VALUES
  ('cekirdek.operasyon', 'kod', 'Kod', '{"en":"Code"}', 'Kimlik', 10, 'metin', NULL, 'kolon', true, true, true, NULL),
  ('cekirdek.operasyon', 'ad', 'Ad', '{"en":"Name"}', 'Kimlik', 20, 'metin', NULL, 'kolon', true, true, true, NULL),
  ('cekirdek.operasyon', 'rol', 'Rol', '{"en":"Role"}', 'Kimlik', 30, 'iliski', 'cekirdek.operasyon_rolu', 'kolon', true, true, true,
   'Çekirdek davranışı role bağlıdır: dış tedarik kapasiteye yazılmaz, kalite onayı sonraki adımı bekletir.'),
  ('cekirdek.operasyon', 'varsayilan_is_merkezi_id', 'Varsayılan iş merkezi', '{"en":"Default work center"}', 'Kapasite', 10, 'iliski', 'cekirdek.is_merkezi', 'kolon', false, true, false,
   'Rota adımında iş merkezi boş bırakılırsa bu kullanılır.'),
  ('cekirdek.operasyon', 'aktif', 'Aktif', '{"en":"Active"}', 'Kimlik', 90, 'evet_hayir', NULL, 'kolon', true, true, false, NULL);
`,p=`-- 0018 · ROTA ADIMI: FASON (DIS TEDARIK) SURESI IS GUNU
--
-- Olcum (15 Eyl 2026, kapasite ekrani ilk gercek yuk): 300 adet mamulun fason boya adimi (30 dk/adet)
-- dakikadan gune cevrilince 9.000 dk / 480 = 19 is gunu cikti ve emir "+32 gun gec" gorundu. Fason isi
-- sirali 8 saatlik is degildir; suresi TEDARIKCININ VERDIGI GUNDUR. Dakika alani maliyet icin kalir.
-- Kapasite (cekirdek/kapasite.ts) bu kolonu kullanir; bossa dakikadan tahmin eder ve UYARI verir.

SELECT sistem.baglam_kur('kurulum', NULL, '0018_rota_adim_fason_gun', 'fason suresi is gunu');

ALTER TABLE cekirdek.rota_adim
  ADD COLUMN dis_tedarik_gun numeric CHECK (dis_tedarik_gun IS NULL OR dis_tedarik_gun >= 0);

COMMENT ON COLUMN cekirdek.rota_adim.dis_tedarik_gun IS
  'Dis tedarik (fason) adiminin suresi, is gunu. Kapasiteye yazilmaz. Bos = dakikadan tahmin (uyarili).';
`,U=`-- 0019 · TEDARIK KOSULU (kalem × tedarikci) + belge para birimi + tedarikci performansi
--
-- Satin alma onerisinin suresi, asgari miktari ve fiyati KALEM KARTINDA degil, o kalemi kimden aldigina
-- baglidir. Bir kalemin birden cok tedarikcisi olabilir; MRP varsayilan olanla planlar.
--   birim            : fiyat, asgari siparis ve siparis kati bu birimde (tedarikcinin sattigi birim)
--   tedarik_suresi_gun: bos = kalem kartindaki sure
--   asgari_siparis   : oneri bundan az olamaz;  siparis_kati: oneri bunun katina yuvarlanir
-- Stok gibi performans da SAKLANMAZ: tedarikci_performansi mal kabul hareketinden hesaplanir (ilke 1).

SELECT sistem.baglam_kur('kurulum', NULL, '0019_tedarik_kosulu', 'tedarik kosulu');

CREATE TABLE cekirdek.tedarik_kosulu (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kalem_id            uuid NOT NULL REFERENCES cekirdek.kalem(id) ON DELETE CASCADE,
  partner_id          uuid NOT NULL REFERENCES cekirdek.partner(id),
  birim               text NOT NULL REFERENCES cekirdek.birim(kod),
  birim_fiyat         numeric CHECK (birim_fiyat IS NULL OR birim_fiyat >= 0),
  para_birimi         text NOT NULL DEFAULT 'TRY' CHECK (para_birimi ~ '^[A-Z]{3}$'),
  tedarik_suresi_gun  numeric CHECK (tedarik_suresi_gun IS NULL OR tedarik_suresi_gun >= 0),
  asgari_siparis      numeric CHECK (asgari_siparis IS NULL OR asgari_siparis > 0),
  siparis_kati        numeric CHECK (siparis_kati IS NULL OR siparis_kati > 0),
  varsayilan          boolean NOT NULL DEFAULT false,
  aktif               boolean NOT NULL DEFAULT true,
  ozellik             jsonb NOT NULL DEFAULT '{}',
  olusturma           timestamptz NOT NULL DEFAULT now(),
  guncelleme          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kalem_id, partner_id)
);
CREATE UNIQUE INDEX tedarik_kosulu_tek_varsayilan ON cekirdek.tedarik_kosulu (kalem_id) WHERE varsayilan AND aktif;
CREATE INDEX tedarik_kosulu_partner ON cekirdek.tedarik_kosulu (partner_id);
SELECT sistem.varlik_kaydet('cekirdek.tedarik_kosulu');

CREATE OR REPLACE FUNCTION cekirdek.tedarik_kosulu_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_roller text[]; v_kod text;
BEGIN
  SELECT roller, kod INTO v_roller, v_kod FROM cekirdek.partner WHERE id = NEW.partner_id;
  IF NOT (v_roller && ARRAY['tedarikci','fasoncu']) THEN
    RAISE EXCEPTION 'Tedarik koşulu: % tedarikçi ya da fasoncu değil (roller: %).', v_kod, array_to_string(v_roller, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_tedarik_kosulu_kapisi BEFORE INSERT OR UPDATE ON cekirdek.tedarik_kosulu
FOR EACH ROW EXECUTE FUNCTION cekirdek.tedarik_kosulu_kapisi();

ALTER TABLE cekirdek.belge ADD COLUMN para_birimi text NOT NULL DEFAULT 'TRY' CHECK (para_birimi ~ '^[A-Z]{3}$');

-- Tedarikci performansi: tamamlanmis satin alma satirlari, SON mal kabul gunu termine gore.
CREATE OR REPLACE VIEW cekirdek.tedarikci_performansi AS
WITH teslim AS (
  SELECT b.partner_id, s.id AS satir_id, s.termin,
         max(h.zaman)::date AS son_kabul
  FROM cekirdek.belge b
  JOIN cekirdek.belge_satir s ON s.belge_id = b.id
  JOIN cekirdek.stok_hareket h ON h.belge_satir_id = s.id AND h.tur = 'mal_kabul'
  WHERE b.tur = 'satinalma_siparisi' AND b.partner_id IS NOT NULL AND s.durum = 'tamam' AND s.termin IS NOT NULL
  GROUP BY b.partner_id, s.id, s.termin
)
SELECT p.id AS partner_id, p.kod, p.ad,
       count(t.satir_id)::int AS teslim_satiri,
       count(t.satir_id) FILTER (WHERE t.son_kabul <= t.termin)::int AS zamaninda,
       CASE WHEN count(t.satir_id) > 0 THEN round(100.0 * count(t.satir_id) FILTER (WHERE t.son_kabul <= t.termin) / count(t.satir_id), 1) END AS zamaninda_yuzde,
       round(avg(GREATEST(t.son_kabul - t.termin, 0)) FILTER (WHERE t.son_kabul > t.termin), 1) AS ortalama_gecikme_gun
FROM cekirdek.partner p
LEFT JOIN teslim t ON t.partner_id = p.id
WHERE p.roller && ARRAY['tedarikci','fasoncu']
GROUP BY p.id, p.kod, p.ad;
GRANT SELECT ON cekirdek.tedarikci_performansi TO authenticated;
`,C=`-- 0020 · ROTA ADIMI: FASON BIRIM FIYATI (maliyet)
--
-- Urun maliyetinde dis tedarik (fason) adimi is merkezi saat maliyetiyle hesaplanamaz: fasoncunun
-- adet basina fiyatidir. Bos = tanimsiz; maliyet toplami bos kalir ve "fason fiyati yok" der (sessiz 0 yok).

SELECT sistem.baglam_kur('kurulum', NULL, '0020_rota_adim_fason_fiyat', 'fason birim fiyati');

ALTER TABLE cekirdek.rota_adim
  ADD COLUMN dis_tedarik_birim_fiyat numeric CHECK (dis_tedarik_birim_fiyat IS NULL OR dis_tedarik_birim_fiyat >= 0);

COMMENT ON COLUMN cekirdek.rota_adim.dis_tedarik_birim_fiyat IS
  'Dis tedarik (fason) adiminin adet basina fiyati, firma para biriminde. Maliyet hesabi kullanir.';
`,D=`-- 0021 · LOT KALITE DURUMU + IZLENEBILIRLIK
--
-- Lot tablosu (0005) ve "lot takipli kaleme lotsuz hareket girilmez" kapisi vardi; akis yoktu.
--   * kalite_karari: lota verilen karar (karantina / serbest / red). Yalniz EKLENIR (defter). Lotun
--     guncel durumu SAKLANMAZ: son karardir (lot_durum gorunumu). Karari olmayan lot serbesttir.
--   * lot_durum: lot + kalite durumu + stok (hareketlerden) + son kullanma.
--   * lot_izlenebilirlik(lot, 'geri'|'ileri'): ayni uretim emri satirindaki tuketim ve cikti
--     hareketleri lotlari birbirine baglar. Geri: bu lot hangi lotlardan, hangi tedarikciden;
--     ileri: hangi urun lotlarina girdi, hangi musteriye sevk edildi. Ayri soy tablosu YOK (ilke 1).

SELECT sistem.baglam_kur('kurulum', NULL, '0021_lot_kalite_izlenebilirlik', 'lot kalite ve izlenebilirlik');

CREATE TABLE cekirdek.kalite_karari (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zaman           timestamptz NOT NULL DEFAULT clock_timestamp(),
  lot_id          uuid NOT NULL REFERENCES cekirdek.lot(id),
  karar           text NOT NULL CHECK (karar IN ('karantina','serbest','red')),
  aciklama        text,
  belge_satir_id  uuid REFERENCES cekirdek.belge_satir(id),
  olusturma       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kalite_karari_lot ON cekirdek.kalite_karari (lot_id, zaman DESC);
SELECT sistem.varlik_kaydet('cekirdek.kalite_karari', 'id');

-- Karar degistirilmez: yeni karar eklenir. (Silme yalniz islem geri alma icindir.)
CREATE OR REPLACE FUNCTION cekirdek.kalite_karari_degismez()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Kalite kararı değiştirilemez; yeni karar girin.' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER b_degismez BEFORE UPDATE ON cekirdek.kalite_karari
FOR EACH ROW EXECUTE FUNCTION cekirdek.kalite_karari_degismez();

CREATE INDEX stok_hareket_lot ON cekirdek.stok_hareket (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX lot_kalem ON cekirdek.lot (kalem_id);

CREATE OR REPLACE VIEW cekirdek.lot_durum AS
SELECT l.id AS lot_id, l.kalem_id, k.kod AS kalem_kod, l.lot_no, l.uretim_tarihi, l.son_kullanma,
       COALESCE(kk.karar, 'serbest') AS kalite_durumu, kk.zaman AS karar_zamani, kk.aciklama AS karar_aciklamasi,
       COALESCE(s.miktar, 0) AS stok, k.stok_birimi,
       CASE WHEN COALESCE(kk.karar, 'serbest') <> 'serbest' THEN COALESCE(kk.karar, 'serbest')
            WHEN l.son_kullanma < CURRENT_DATE THEN 'son_kullanma_gecti' END AS kullanilamaz_neden
FROM cekirdek.lot l
JOIN cekirdek.kalem k ON k.id = l.kalem_id
LEFT JOIN LATERAL (SELECT karar, zaman, aciklama FROM cekirdek.kalite_karari WHERE lot_id = l.id ORDER BY zaman DESC LIMIT 1) kk ON true
LEFT JOIN LATERAL (SELECT sum(miktar) AS miktar FROM cekirdek.stok_hareket WHERE lot_id = l.id) s ON true;
GRANT SELECT ON cekirdek.lot_durum TO authenticated;

-- Kullanilabilir stok: lotsuz stok + serbest ve son kullanmasi gecmemis lotlar. MRP, tuketim ve sevk
-- bunu kullanir; karantina/red/gecmis lot fiziksel stokta (stok_durum) gorunur ama planlamaya girmez.
CREATE OR REPLACE VIEW cekirdek.stok_kullanilabilir AS
SELECT d.kalem_id, d.depo_id, d.lot_id, d.miktar, ld.lot_no, ld.son_kullanma, ld.uretim_tarihi
FROM cekirdek.stok_durum d
LEFT JOIN cekirdek.lot_durum ld ON ld.lot_id = d.lot_id
WHERE d.lot_id IS NULL OR ld.kullanilamaz_neden IS NULL;
GRANT SELECT ON cekirdek.stok_kullanilabilir TO authenticated;

CREATE OR REPLACE FUNCTION cekirdek.lot_izlenebilirlik(p_lot_id uuid, p_yon text DEFAULT 'geri')
RETURNS TABLE (derinlik int, lot_id uuid, kalem_kod text, lot_no text, belge_turu text, belge_no text, hareket_turu text, miktar numeric, partner_kod text)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_yon NOT IN ('geri','ileri') THEN RAISE EXCEPTION 'Yön geri ya da ileri olmalı: %', p_yon; END IF;
  RETURN QUERY
  WITH RECURSIVE zincir(derinlik, lot_id, yol) AS (
    SELECT 0, p_lot_id, ARRAY[p_lot_id]
    UNION ALL
    SELECT z.derinlik + 1, h2.lot_id, z.yol || h2.lot_id
    FROM zincir z
    JOIN cekirdek.stok_hareket h1 ON h1.lot_id = z.lot_id
      AND h1.tur = CASE WHEN p_yon = 'geri' THEN 'uretim_cikti' ELSE 'uretim_tuketim' END
    JOIN cekirdek.stok_hareket h2 ON h2.belge_satir_id = h1.belge_satir_id AND h2.lot_id IS NOT NULL
      AND h2.tur = CASE WHEN p_yon = 'geri' THEN 'uretim_tuketim' ELSE 'uretim_cikti' END
    WHERE NOT h2.lot_id = ANY (z.yol) AND z.derinlik < 20
  ),
  lotlar AS (SELECT min(derinlik) AS derinlik, zincir.lot_id FROM zincir GROUP BY zincir.lot_id)
  -- her lotun kaynak (geri: mal kabul) ya da hedef (ileri: sevk) hareketleri + baglandigi uretim emri
  SELECT lt.derinlik, lt.lot_id, k.kod, l.lot_no,
         b.tur, b.no, h.tur, abs(h.miktar), p.kod
  FROM lotlar lt
  JOIN cekirdek.lot l ON l.id = lt.lot_id
  JOIN cekirdek.kalem k ON k.id = l.kalem_id
  JOIN cekirdek.stok_hareket h ON h.lot_id = lt.lot_id
    AND h.tur IN ('mal_kabul','uretim_cikti','uretim_tuketim','satis_cikis','fire')
  JOIN cekirdek.belge_satir s ON s.id = h.belge_satir_id
  JOIN cekirdek.belge b ON b.id = s.belge_id
  LEFT JOIN cekirdek.partner p ON p.id = b.partner_id
  WHERE (p_yon = 'geri' AND h.tur IN ('mal_kabul','uretim_cikti'))
     OR (p_yon = 'ileri' AND h.tur IN ('uretim_tuketim','satis_cikis','fire'))
  ORDER BY 1, 3, 4, 6;
END $$;
GRANT EXECUTE ON FUNCTION cekirdek.lot_izlenebilirlik(uuid, text) TO authenticated;

-- Geri al: ayni islemde acilan lot, hareketi ters kayitla dengelendikten sonra silinmek istenince
-- stok_hareket FK'si durduruyordu. Defterde gecen lot kalir (stok 0).
CREATE OR REPLACE FUNCTION sistem.islem_geri_al(p_grup uuid, p_gerekce text DEFAULT NULL, p_zorla boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  o        sistem.olay%ROWTYPE;
  v_yeni_grup uuid;
  v_simdiki jsonb;
  v_sayi   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sistem.olay WHERE islem_grubu = p_grup) THEN
    RAISE EXCEPTION 'Islem grubu bulunamadi: %', p_grup;
  END IF;

  v_yeni_grup := sistem.baglam_kur('geri_al', sistem.baglam('kullanici'), p_grup::text,
                                   COALESCE(p_gerekce, 'islem grubu geri alindi'));

  FOR o IN SELECT * FROM sistem.olay WHERE islem_grubu = p_grup ORDER BY id DESC LOOP
    EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %I::text = $1', o.varlik, o.anahtar_alan)
      INTO v_simdiki USING o.kayit_id;

    IF o.islem = 'ekle' THEN
      IF v_simdiki IS NULL THEN CONTINUE; END IF;
      IF o.varlik = 'cekirdek.stok_hareket' THEN
        -- Defter: silinmez, ters kayitla dengelenir.
        IF EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE ters_hareket_id = o.kayit_id::uuid) THEN
          RAISE EXCEPTION 'Geri alinamaz: stok hareketi % zaten ters kayitla duzeltilmis.', o.kayit_id;
        END IF;
        PERFORM cekirdek.stok_hareket_ters_kayit(o.kayit_id::uuid, 'geri alındı: işlem ' || p_grup::text);
      ELSIF o.varlik = 'cekirdek.lot' AND EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE lot_id = o.kayit_id::uuid) THEN
        -- Lot defterde geciyor (asil + ters kayit): silinmez, stoku 0 olarak kalir.
        NULL;
      ELSE
        EXECUTE format('DELETE FROM %s WHERE %I::text = $1', o.varlik, o.anahtar_alan) USING o.kayit_id;
      END IF;

    ELSIF o.islem = 'sil' THEN
      IF v_simdiki IS NOT NULL AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% silindikten sonra yeniden olusturulmus.', o.varlik, o.kayit_id;
      END IF;
      EXECUTE format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, $1)', o.varlik) USING o.eski;

    ELSE -- degistir
      IF v_simdiki IS NULL THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% artik yok.', o.varlik, o.kayit_id;
      END IF;
      IF (v_simdiki -> o.alan) IS DISTINCT FROM o.yeni AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/%.% bu islemden sonra degistirilmis (simdi %, islem %).',
          o.varlik, o.kayit_id, o.alan, v_simdiki -> o.alan, o.yeni;
      END IF;
      EXECUTE format(
        'UPDATE %1$s SET %2$I = (jsonb_populate_record(NULL::%1$s, $1)).%2$I WHERE %3$I::text = $2',
        o.varlik, o.alan, o.anahtar_alan)
        USING jsonb_build_object(o.alan, o.eski), o.kayit_id;
    END IF;
    v_sayi := v_sayi + 1;
  END LOOP;

  RETURN v_yeni_grup;
END $$;
`,z=`-- 0022 · OPERASYON GERCEKLESEN SURE KAYDI (is emri geri bildirimi)
--
-- Simdiye kadar bir emrin DONUSUM maliyeti (iscilik, makine, fason) ROTA PLANINDAN aliniyordu:
-- gerceklesen maliyet ekraninda "donusum sapmasi" tanim geregi 0 cikiyordu (bkz. degerleme.ts).
-- Eksik olan tek girdi sahadan gelen suredir.
--
--   * operasyon_kaydi: bir emir satirinda BIR KAYNAGIN (operator/makine) BIR adimda harcadigi sure.
--     Defterdir: kapanan kayit degistirilmez, silinmez; duzeltme = iptal + yeni kayit.
--     Ayni kaynak ayni adimda iki kez calistiysa IKI kayit olur; toplami emrin suresidir.
--     Birden cok operator ayni adimda calistiysa her biri ayri kayittir (kisi-saat dogru toplanir).
--   * tur: 'hazirlik' ya da 'islem' — plan da bu ikisini ayirir (rota_adim.hazirlik_dk / islem_dk).
--   * sure_dk bos = bitis − baslangic (kronometre). Elle girilen sure varsa O gecerlidir (kayit
--     vardiya sonunda girilebilsin diye); ikisi de yoksa kayit ACIKTIR ve suresi sayilmaz.
--   * DIS TEDARIK adimina sure kaydi girilmez: fasonun suresi tedarikcinin gunudur (#0018),
--     maliyeti adet basina fiyattir (#0020). Kapi reddeder.
--
-- Maliyet: kaynak saat maliyeti > is merkezi saat maliyeti. Kayitsiz kalan adim PLANDAN alinir ve
-- UYARI verir (cekirdek/operasyon.ts): eksik kayit sessizce "ucuz uretim" gostermez.

SELECT sistem.baglam_kur('kurulum', NULL, '0022_operasyon_kaydi', 'operasyon gerceklesen sure kaydi');

CREATE TABLE cekirdek.operasyon_kaydi (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  belge_satir_id  uuid NOT NULL REFERENCES cekirdek.belge_satir(id),
  rota_adim_id    uuid REFERENCES cekirdek.rota_adim(id),
  operasyon_id    uuid NOT NULL REFERENCES cekirdek.operasyon(id),
  is_merkezi_id   uuid REFERENCES cekirdek.is_merkezi(id),
  kaynak_id       uuid REFERENCES cekirdek.kaynak(id),
  tur             text NOT NULL DEFAULT 'islem' CHECK (tur IN ('hazirlik','islem')),
  baslangic       timestamptz NOT NULL DEFAULT clock_timestamp(),
  bitis           timestamptz,
  sure_dk         numeric CHECK (sure_dk IS NULL OR sure_dk >= 0),
  miktar          numeric CHECK (miktar IS NULL OR miktar >= 0),
  fire_miktar     numeric NOT NULL DEFAULT 0 CHECK (fire_miktar >= 0),
  iptal           boolean NOT NULL DEFAULT false,
  aciklama        text,
  ozellik         jsonb NOT NULL DEFAULT '{}',
  olusturma       timestamptz NOT NULL DEFAULT now(),
  guncelleme      timestamptz NOT NULL DEFAULT now(),
  CHECK (bitis IS NULL OR bitis >= baslangic)
);
CREATE INDEX operasyon_kaydi_satir ON cekirdek.operasyon_kaydi (belge_satir_id, baslangic);
CREATE INDEX operasyon_kaydi_kaynak ON cekirdek.operasyon_kaydi (kaynak_id) WHERE kaynak_id IS NOT NULL;

-- Ayni kaynak ayni adimda iki kez "basladi" olamaz: acik kayit tektir.
CREATE UNIQUE INDEX operasyon_kaydi_tek_acik ON cekirdek.operasyon_kaydi
  (belge_satir_id, COALESCE(rota_adim_id, '00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(kaynak_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE bitis IS NULL AND sure_dk IS NULL AND NOT iptal;

COMMENT ON COLUMN cekirdek.operasyon_kaydi.sure_dk IS
  'Elle girilen sure (dk). Bos = bitis − baslangic. Ikisi de yoksa kayit aciktir, suresi sayilmaz.';
COMMENT ON COLUMN cekirdek.operasyon_kaydi.miktar IS
  'Bu kayitta tamamlanan miktar (emir satirinin stok biriminde). Stok hareketi DEGILDIR; cikti "Tamamla" ile yazilir.';

SELECT sistem.varlik_kaydet('cekirdek.operasyon_kaydi');

-- ---------------------------------------------------------------------------
-- KAPI: emir satiri uretim emri olmali, dis tedarik adimina kayit girilmez,
--       kapanan kayit degismez, silme yalniz islem geri alma icindir.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cekirdek.operasyon_kaydi_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tur  text;
  v_rol  text;
  v_rota uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(sistem.baglam('kaynak'), '') <> 'geri_al' THEN
      RAISE EXCEPTION 'Operasyon kaydi silinemez. Duzeltme icin kaydi iptal edip yenisini girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Kapanmis kayit yalniz IPTAL edilebilir (ve iptal gerekcesi yazilabilir).
    IF (OLD.bitis IS NOT NULL OR OLD.sure_dk IS NOT NULL)
       AND (to_jsonb(NEW) - 'iptal' - 'aciklama' - 'guncelleme') IS DISTINCT FROM (to_jsonb(OLD) - 'iptal' - 'aciklama' - 'guncelleme') THEN
      RAISE EXCEPTION 'Kapanmis operasyon kaydi degistirilemez; iptal edip yeni kayit girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.iptal AND NOT NEW.iptal THEN
      RAISE EXCEPTION 'Iptal edilmis operasyon kaydi geri acilamaz; yeni kayit girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.iptal AND NULLIF(btrim(COALESCE(NEW.aciklama, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Operasyon kaydi aciklamasiz iptal edilemez.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT b.tur INTO v_tur FROM cekirdek.belge_satir s JOIN cekirdek.belge b ON b.id = s.belge_id WHERE s.id = NEW.belge_satir_id;
  IF v_tur <> 'uretim_emri' THEN
    RAISE EXCEPTION 'Operasyon kaydi yalniz uretim emri satirina girilir (belge turu: %).', v_tur USING ERRCODE = 'check_violation';
  END IF;

  SELECT rol INTO v_rol FROM cekirdek.operasyon WHERE id = NEW.operasyon_id;
  IF v_rol = 'dis_tedarik' THEN
    RAISE EXCEPTION 'Dis tedarik (fason) adimina sure kaydi girilmez: suresi tedarikcinin gunudur, maliyeti adet basina fiyattir.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.rota_adim_id IS NOT NULL THEN
    SELECT rota_id INTO v_rota FROM cekirdek.rota_adim WHERE id = NEW.rota_adim_id;
    IF NOT EXISTS (SELECT 1 FROM cekirdek.rota r JOIN cekirdek.belge_satir s ON s.id = NEW.belge_satir_id
                   WHERE r.id = v_rota AND r.kalem_id = s.kalem_id) THEN
      RAISE EXCEPTION 'Rota adimi bu emrin kalemine ait degil.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER b_kapi BEFORE INSERT OR UPDATE OR DELETE ON cekirdek.operasyon_kaydi
FOR EACH ROW EXECUTE FUNCTION cekirdek.operasyon_kaydi_kapisi();

-- ---------------------------------------------------------------------------
-- GORUNUM: etkin sure ve saat maliyeti tek yerde cozulur (is merkezi: kayit > rota adimi >
-- operasyonun varsayilani; saat maliyeti: KAYNAK > is merkezi — operator/makine ayri fiyatlanabilsin).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cekirdek.operasyon_kaydi_v AS
SELECT ok.id, ok.belge_satir_id, b.no AS belge_no, s.kalem_id, k.kod AS kalem_kod, k.stok_birimi,
       ok.rota_adim_id, ra.sira AS adim_sira, o.id AS operasyon_id, o.kod AS operasyon_kod, o.ad AS operasyon_ad, o.rol AS operasyon_rolu,
       im.id AS is_merkezi_id, im.kod AS is_merkezi_kod, ok.kaynak_id, kn.kod AS kaynak_kod, kn.ad AS kaynak_ad,
       ok.tur, ok.baslangic, ok.bitis, ok.iptal, ok.miktar, ok.fire_miktar, ok.aciklama,
       CASE WHEN ok.iptal THEN NULL
            ELSE COALESCE(ok.sure_dk, EXTRACT(EPOCH FROM (ok.bitis - ok.baslangic)) / 60.0) END AS etkin_sure_dk,
       COALESCE(kn.saat_maliyeti, im.saat_maliyeti) AS saat_maliyeti
FROM cekirdek.operasyon_kaydi ok
JOIN cekirdek.belge_satir s ON s.id = ok.belge_satir_id
JOIN cekirdek.belge b ON b.id = s.belge_id
JOIN cekirdek.kalem k ON k.id = s.kalem_id
JOIN cekirdek.operasyon o ON o.id = ok.operasyon_id
LEFT JOIN cekirdek.rota_adim ra ON ra.id = ok.rota_adim_id
LEFT JOIN cekirdek.is_merkezi im ON im.id = COALESCE(ok.is_merkezi_id, ra.is_merkezi_id, o.varsayilan_is_merkezi_id)
LEFT JOIN cekirdek.kaynak kn ON kn.id = ok.kaynak_id;
GRANT SELECT ON cekirdek.operasyon_kaydi_v TO authenticated;
`,v=`-- 0023 · DOVIZ KURU TABLOSU
--
-- Bugune kadar firma para biriminden FARKLI para birimindeki her fiyat "kur tanimsiz" diye
-- KULLANILMIYORDU: tedarik kosulu EUR ise kalemin maliyeti bos, o kalemden uretilen her seyin
-- maliyeti bos, mal kabulu degerlenemedigi icin stok degeri bos kaliyordu (veri/maliyet.ts).
--
--   kur = 1 birim YABANCI para kac birim FIRMA parasi eder (1 EUR = 47,20 TRY -> kur 47.20)
--   tarih = kurun GECERLILIK gunu. Arama: istenen tarihten ONCEKI (ya da esit) EN SON kur.
--           ILERIYE BAKILMAZ: 12 Eyl'deki mal kabul 15 Eyl kuruyla degerlenmez.
--   tur   = ayni gun birden cok kur olabilir (TCMB doviz alis/satis, efektif, ortalama). Maliyet
--           'alis' kurunu kullanir; digerleri ileride satis/raporlama icin durur.
--
-- Firma para birimi bu tabloya YAZILMAZ (kuru tanim geregi 1'dir); kapi reddeder.
-- Kur bulunamazsa sonuc yine BOS kalir ve "EUR/TRY kuru <tarih> ve oncesi icin tanimsiz" der:
-- eski davranistan tek farki, kur GIRILDIGINDE calismasidir. Sessizce 1 sayilmaz.

SELECT sistem.baglam_kur('kurulum', NULL, '0023_kur', 'doviz kuru tablosu');

CREATE TABLE cekirdek.kur (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  para_birimi   text NOT NULL CHECK (para_birimi ~ '^[A-Z]{3}$'),
  tarih         date NOT NULL,
  kur           numeric NOT NULL CHECK (kur > 0),
  tur           text NOT NULL DEFAULT 'alis' CHECK (tur IN ('alis','satis','efektif_alis','efektif_satis','ortalama')),
  kaynak        text,
  ozellik       jsonb NOT NULL DEFAULT '{}',
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (para_birimi, tarih, tur)
);
CREATE INDEX kur_arama ON cekirdek.kur (para_birimi, tur, tarih DESC);

COMMENT ON COLUMN cekirdek.kur.kur IS '1 birim yabanci para = kac birim firma parasi (sistem.firma.para_birimi).';
COMMENT ON COLUMN cekirdek.kur.tarih IS 'Gecerlilik gunu. Arama bu tarihten onceki en son kuru alir; ileriye bakmaz.';

-- Katalog kaydi YOK: anahtari (para birimi, tarih, tur) ucludur, genel kod-anahtarli aktarim yazamaz.
-- Tedarik kosulu gibi KENDI Excel aktarimi vardir (src/aktarim/kur.ts, sihirbaz -> Veriler -> Kurlar).

SELECT sistem.varlik_kaydet('cekirdek.kur');

-- Firma parasinin kuru 1'dir, tabloda durmaz.
CREATE OR REPLACE FUNCTION cekirdek.kur_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_firma text;
BEGIN
  SELECT para_birimi INTO v_firma FROM sistem.firma;
  IF NEW.para_birimi = v_firma THEN
    RAISE EXCEPTION 'Firma para birimi (%) icin kur girilmez: kuru 1''dir.', v_firma USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_kapi BEFORE INSERT OR UPDATE ON cekirdek.kur
FOR EACH ROW EXECUTE FUNCTION cekirdek.kur_kapisi();

-- ---------------------------------------------------------------------------
-- ARAMA: istenen tarihten onceki (ya da esit) EN SON kur. Firma parasi -> 1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cekirdek.kur_bul(p_para text, p_tarih date DEFAULT CURRENT_DATE, p_tur text DEFAULT 'alis')
RETURNS TABLE (kur numeric, tarih date, tur text, kaynak text)
LANGUAGE sql STABLE AS $$
  SELECT 1::numeric, p_tarih, 'firma', NULL::text
  WHERE p_para = (SELECT para_birimi FROM sistem.firma)
  UNION ALL
  SELECT k.kur, k.tarih, k.tur, k.kaynak
  FROM cekirdek.kur k
  WHERE k.para_birimi = p_para AND k.tur = p_tur AND k.tarih <= p_tarih
    AND p_para <> (SELECT para_birimi FROM sistem.firma)
  ORDER BY 2 DESC
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION cekirdek.kur_bul(text, date, text) TO authenticated;

-- Her para biriminin bilinen EN SON kuru (ekran ozeti).
CREATE OR REPLACE VIEW cekirdek.kur_guncel AS
SELECT DISTINCT ON (para_birimi, tur) para_birimi, tur, tarih, kur, kaynak
FROM cekirdek.kur
ORDER BY para_birimi, tur, tarih DESC;
GRANT SELECT ON cekirdek.kur_guncel TO authenticated;
`,F=`-- 0024 · SAHADA BILDIRILEN FIRE MALZEMEYI DEFTERDEN DUSER
--
-- 0022 operasyon kaydina "fire_miktar" yazilabiliyordu ama hicbir sey olmuyordu: hurdaya giden
-- parcalarin malzemesi stokta DURUYOR gorunuyordu (defter gercegin gerisinde kaliyordu). Cunku
-- tuketim yalniz "Tamamla"da, IYI CIKTI kadar yazilir; hurda olan parcanin malzemesi hic dusulmez.
--
-- Eksik olan tek bilgi: bir bilesen HANGI ADIMDA ise girer. 2. adimda hurdaya cikan parca 3. adimin
-- malzemesini harcamamistir. Bu bilgi urun agaci satirina yazilir:
--
--   urun_agaci_satir.rota_adim_sira = bilesenin ise girdigi rota adiminin sirasi
--     BOS = ILK ADIM (varsayilan). Bu varsayim SESSIZ DEGILDIR: ekranda ve fire aciklamasinda
--     "adimi belirtilmemis bilesen ilk adimda girer" diye yazar; firma isterse adim yazar.
--
-- Fire bildirilince (cekirdek.operasyon_kaydi.fire_miktar > 0) o ADIMA KADAR (dahil) giren bilesenler
-- fire miktari kadar 'fire' turu hareketle dusulur. Hareket kaydin kendisine baglidir:
--
--   stok_hareket.operasyon_kaydi_id -> kayit iptal edilince TERS KAYIT yazilabilsin (defter silinmez).
--
-- Stok yetmezse hicbir sey yazilmaz (uretim tuketimiyle ayni kural): fire bildirimi, stok verisinin
-- yanlis oldugunu soyler. Fire IYI CIKTI DEGILDIR: emrin kalan miktari degismez, hurda parca yeniden uretilir.

SELECT sistem.baglam_kur('kurulum', NULL, '0024_fire_malzeme_cikisi', 'fire malzeme cikisi');

ALTER TABLE cekirdek.urun_agaci_satir
  ADD COLUMN rota_adim_sira int CHECK (rota_adim_sira IS NULL OR rota_adim_sira > 0);

COMMENT ON COLUMN cekirdek.urun_agaci_satir.rota_adim_sira IS
  'Bilesenin ise girdigi rota adiminin sirasi. Bos = ilk adim (varsayilan; fire hesabinda aciklamayla yazilir).';

ALTER TABLE cekirdek.stok_hareket
  ADD COLUMN operasyon_kaydi_id uuid REFERENCES cekirdek.operasyon_kaydi(id);

CREATE INDEX stok_hareket_operasyon ON cekirdek.stok_hareket (operasyon_kaydi_id) WHERE operasyon_kaydi_id IS NOT NULL;

COMMENT ON COLUMN cekirdek.stok_hareket.operasyon_kaydi_id IS
  'Hareketi doguran operasyon kaydi (fire cikisi). Kayit iptal edilince bu hareketler ters kayitla dengelenir.';
`,f=`-- 0025 · GENEL GIDER (is merkezi saat orani)
--
-- Urun maliyeti bugune kadar MALZEME + ISCILIK/MAKINE + FASON idi. Fabrikanin isinmasi, amortismani,
-- bakimi, ustabasi maasi hicbir urune yuklenmiyordu: her urun OLDUGUNDAN UCUZ gorunuyordu ve satis
-- fiyati bu eksik maliyetin uzerine konuyordu.
--
--   is_merkezi.genel_gider_saat = o is merkezinde gecen SAAT BASINA yuklenen genel gider
--   genel gider = rota suresi (saat) × genel_gider_saat        (iscilikle AYNI sure, AYRI oran)
--
-- NEDEN SAAT TABANI: uretimde genel giderin tasiyicisi zamandir (makine calistigi surece isinir,
-- eskir, bakim ister). "Malzeme bedelinin yuzdesi" tabani pahali malzemeli urune haksiz yuk bindirir
-- ve sektorden sektore degisir. Firma isterse orani saat maliyetine gomebilir; AYRI kolon olmasi
-- maliyetin hangi parcasinin genel gider oldugunu GORUNUR kilar (ilke 4: her sayi hesabini gosterir).
--
-- Bos birakilirsa genel gider SIFIR degil, "tanimsiz" de degildir: yuklenmez ve maliyet izinde
-- "genel gider orani tanimsiz" diye yazar (sessiz sifir yok, ama toplami da bosaltmaz: genel gider
-- yuklemeyen firma cogunluktur ve onun maliyeti yine gecerlidir).
--
-- Dis tedarik (fason) adimina genel gider yuklenmez: is disarida yapilir, fabrika saati harcanmaz.

SELECT sistem.baglam_kur('kurulum', NULL, '0025_genel_gider', 'is merkezi genel gider orani');

ALTER TABLE cekirdek.is_merkezi
  ADD COLUMN genel_gider_saat numeric CHECK (genel_gider_saat IS NULL OR genel_gider_saat >= 0);

COMMENT ON COLUMN cekirdek.is_merkezi.genel_gider_saat IS
  'Saat basina yuklenen genel gider (firma para biriminde). Bos = genel gider yuklenmez.';

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, depolama, sistem_alani, gorunur, zorunlu, aciklama) VALUES
  ('cekirdek.is_merkezi', 'genel_gider_saat', 'Genel gider (saat)', '{"en":"Overhead per hour"}', 'Maliyet', 20, 'para', 'kolon', false, true, false,
   'Saat başına yüklenen genel gider: ısınma, amortisman, bakım, ustabaşı. Boş bırakılırsa genel gider yüklenmez.');

-- Operasyon kaydi gorunumu: genel gider orani IS MERKEZINDEN gelir (kaynaga gore degismez).
CREATE OR REPLACE VIEW cekirdek.operasyon_kaydi_v AS
SELECT ok.id, ok.belge_satir_id, b.no AS belge_no, s.kalem_id, k.kod AS kalem_kod, k.stok_birimi,
       ok.rota_adim_id, ra.sira AS adim_sira, o.id AS operasyon_id, o.kod AS operasyon_kod, o.ad AS operasyon_ad, o.rol AS operasyon_rolu,
       im.id AS is_merkezi_id, im.kod AS is_merkezi_kod, ok.kaynak_id, kn.kod AS kaynak_kod, kn.ad AS kaynak_ad,
       ok.tur, ok.baslangic, ok.bitis, ok.iptal, ok.miktar, ok.fire_miktar, ok.aciklama,
       CASE WHEN ok.iptal THEN NULL
            ELSE COALESCE(ok.sure_dk, EXTRACT(EPOCH FROM (ok.bitis - ok.baslangic)) / 60.0) END AS etkin_sure_dk,
       COALESCE(kn.saat_maliyeti, im.saat_maliyeti) AS saat_maliyeti,
       im.genel_gider_saat
FROM cekirdek.operasyon_kaydi ok
JOIN cekirdek.belge_satir s ON s.id = ok.belge_satir_id
JOIN cekirdek.belge b ON b.id = s.belge_id
JOIN cekirdek.kalem k ON k.id = s.kalem_id
JOIN cekirdek.operasyon o ON o.id = ok.operasyon_id
LEFT JOIN cekirdek.rota_adim ra ON ra.id = ok.rota_adim_id
LEFT JOIN cekirdek.is_merkezi im ON im.id = COALESCE(ok.is_merkezi_id, ra.is_merkezi_id, o.varsayilan_is_merkezi_id)
LEFT JOIN cekirdek.kaynak kn ON kn.id = ok.kaynak_id;
GRANT SELECT ON cekirdek.operasyon_kaydi_v TO authenticated;
`,H=`-- 0026 · MALIYET DONEMI ve DONEM MALIYET KAYDI
--
-- Birim maliyet her sorulduğunda YENIDEN hesaplaniyordu: bugunku fiyatlarla, bugunku rotayla.
-- Hicbir yere yazilmadigi icin "gecen ay bu urun kaca mal oluyordu?" ve "neden pahalandi?"
-- sorularinin cevabi YOKTU. Fiyat degisince eski teklifin hangi maliyetle verildigi de kayboluyordu.
--
--   maliyet_donemi : adlandirilmis bir zaman araligi (2026-09 gibi). Hesaplanir, sonra DONDURULUR.
--   kalem_maliyet  : o donemde bir kalemin birim maliyeti ve PARCALARI (malzeme / iscilik / genel
--                    gider / fason). Parcalar ayri durur ki fark SEBEBIYLE okunabilsin:
--                    "3.125 -> 3.410 arttiysa 250'si malzeme, 35'i genel gider".
--
-- DONDURULMUS donem DEGISMEZ: satirlari guncellenemez, silinemez, uzerine yeniden hesaplanamaz.
-- Gecmis maliyet, gecmis fiyatla verilen teklifin kanitidir (ilke: defter yeniden yazilmaz).
--
-- KAPSAM: snapshot GENEL agactan hesaplanir (urune ozel agac varyantlari ayri tutulmaz); ekran ve
-- hesap izi hangi agacin kullanildigini zaten gosterir. Urune ozel maliyet gerekirse ayri surumde.

SELECT sistem.baglam_kur('kurulum', NULL, '0026_maliyet_donemi', 'maliyet donemi');

CREATE TABLE cekirdek.maliyet_donemi (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod         text NOT NULL UNIQUE,
  ad          text NOT NULL,
  baslangic   date NOT NULL,
  bitis       date NOT NULL,
  durum       text NOT NULL DEFAULT 'acik' CHECK (durum IN ('acik','dondurulmus')),
  hesaplama   timestamptz,
  aciklama    text,
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now(),
  CHECK (bitis >= baslangic)
);
SELECT sistem.varlik_kaydet('cekirdek.maliyet_donemi');

CREATE TABLE cekirdek.kalem_maliyet (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donem_id      uuid NOT NULL REFERENCES cekirdek.maliyet_donemi(id) ON DELETE CASCADE,
  kalem_id      uuid NOT NULL REFERENCES cekirdek.kalem(id),
  birim_maliyet numeric,
  malzeme       numeric,
  iscilik       numeric,
  genel_gider   numeric,
  fason         numeric,
  -- Toplam bossa nedeni (eksik fiyat, agacsiz ara kalem, kur yok...)
  eksik_neden   text,
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (donem_id, kalem_id)
);
CREATE INDEX kalem_maliyet_kalem ON cekirdek.kalem_maliyet (kalem_id, donem_id);
SELECT sistem.varlik_kaydet('cekirdek.kalem_maliyet');

-- ---------------------------------------------------------------------------
-- KAPI: dondurulmus donem ve satirlari degismez. Dondurma geri alinmaz.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cekirdek.maliyet_donemi_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.durum = 'dondurulmus' THEN
    IF NEW.durum <> 'dondurulmus' THEN
      RAISE EXCEPTION 'Dondurulmus maliyet donemi (%) geri acilamaz; yeni donem acin.', OLD.kod USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (to_jsonb(NEW) - 'aciklama' - 'guncelleme') IS DISTINCT FROM (to_jsonb(OLD) - 'aciklama' - 'guncelleme') THEN
      RAISE EXCEPTION 'Dondurulmus maliyet donemi (%) degistirilemez.', OLD.kod USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.durum = 'dondurulmus' THEN
    RAISE EXCEPTION 'Dondurulmus maliyet donemi (%) silinemez.', OLD.kod USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER b_kapi BEFORE UPDATE OR DELETE ON cekirdek.maliyet_donemi
FOR EACH ROW EXECUTE FUNCTION cekirdek.maliyet_donemi_kapisi();

CREATE OR REPLACE FUNCTION cekirdek.kalem_maliyet_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_durum text; v_kod text;
BEGIN
  SELECT durum, kod INTO v_durum, v_kod FROM cekirdek.maliyet_donemi
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.donem_id ELSE NEW.donem_id END;
  IF v_durum = 'dondurulmus' THEN
    RAISE EXCEPTION 'Maliyet donemi % dondurulmus: satirlari degistirilemez.', v_kod USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER b_kapi BEFORE INSERT OR UPDATE OR DELETE ON cekirdek.kalem_maliyet
FOR EACH ROW EXECUTE FUNCTION cekirdek.kalem_maliyet_kapisi();

-- ---------------------------------------------------------------------------
-- KARSILASTIRMA: iki donem arasinda kalem basina fark, PARCASIYLA.
-- Yalniz bir donemde olan kalem de doner (digeri NULL): yeni urun / kalkan urun gorunur.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cekirdek.maliyet_karsilastir(p_onceki uuid, p_sonraki uuid)
RETURNS TABLE (
  kalem_id uuid, kalem_kod text, kalem_ad text,
  onceki numeric, sonraki numeric, fark numeric,
  malzeme_fark numeric, iscilik_fark numeric, genel_gider_fark numeric, fason_fark numeric,
  onceki_eksik text, sonraki_eksik text
)
LANGUAGE sql STABLE AS $$
  SELECT k.id, k.kod, k.ad,
         a.birim_maliyet, b.birim_maliyet, b.birim_maliyet - a.birim_maliyet,
         b.malzeme - a.malzeme, b.iscilik - a.iscilik,
         COALESCE(b.genel_gider, 0) - COALESCE(a.genel_gider, 0), COALESCE(b.fason, 0) - COALESCE(a.fason, 0),
         a.eksik_neden, b.eksik_neden
  FROM (SELECT * FROM cekirdek.kalem_maliyet WHERE donem_id = p_onceki) a
  FULL JOIN (SELECT * FROM cekirdek.kalem_maliyet WHERE donem_id = p_sonraki) b ON b.kalem_id = a.kalem_id
  JOIN cekirdek.kalem k ON k.id = COALESCE(a.kalem_id, b.kalem_id)
  ORDER BY k.kod;
$$;
GRANT EXECUTE ON FUNCTION cekirdek.maliyet_karsilastir(uuid, uuid) TO authenticated;
`,M=`-- 0027 · GIRIS MUAYENESI SURESI
--
-- 0021 ile karantinadaki lot MRP'de BEKLENEN GIRIS sayildi ama tarihi BUGUN kabul edildi:
-- "muayene bugun bitecek" varsayimi. Gercekte muayene birkac gun surer ve o gun stoga girmez.
-- Bu, ihtiyac tarihi yakin olan plani OLDUGUNDAN IYIMSER gosterir.
--
--   kalem.ozellik->>'muayene_suresi_gun' = giris muayenesi kac IS GUNU surer
--   beklenen giris tarihi = lotun karantinaya girdigi gun + muayene suresi (is gunu, takvimle)
--   Bos birakilirsa 0: bugun sayilir (eski davranis, geriye uyumlu) ve varsayim ekranda yazar.
--
-- Sure kalem kartindadir cunku muayene MALZEMEYE baglidir: sac numunesi bir gun, boya laboratuvari
-- uc gun surebilir. Tedarikciye degil kaleme yazilir (ayni malzeme her tedarikciden ayni sekilde bakilir).

SELECT sistem.baglam_kur('kurulum', NULL, '0027_muayene_suresi', 'giris muayenesi suresi');

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, depolama, sistem_alani, gorunur, zorunlu, birim, aciklama) VALUES
  ('cekirdek.kalem', 'muayene_suresi_gun', 'Muayene süresi', '{"en":"Inspection lead time"}', 'Kalite ve izlenebilirlik', 45, 'sayi', 'ozellik', false, true, false, 'iş günü',
   'Giriş muayenesi kaç iş günü sürer. MRP karantinadaki malı bu kadar sonra beklenen giriş sayar. Boş = bugün.');
`,h=`-- 0028 · YENI ALANLARIN VERI KALITESI DEDEKTORLERI
--
-- 0022-0027 arasinda gelen alanlarin hicbirinin denetimi yoktu. Hepsi YARIM TANIMLANDIGINDA
-- sessizce yanlis sayi uretir; kullanici sayinin yanlis oldugunu ANLAMAZ:
--
--   D-IM-GENEL-GIDER-YALNIZ : genel gider orani var ama saat maliyeti yok -> iscilik 0, genel gider dolu
--   D-KUR-YOK               : tedarik kosulu doviz ama o para biriminin HIC kuru yok -> maliyet bos
--   D-FASON-FIYAT-YOK       : dis tedarik adiminin adet fiyati yok -> urun maliyeti bos
--   D-AGAC-ADIM-ASKIDA      : agac satirinda adim sirasi var ama rotada o sira yok -> fire hesabi yanlis
--   D-MUAYENE-SURESI-ASKIDA : muayene suresi yazili ama giris muayenesi kapali -> sure hic kullanilmaz
--
-- Hepsi BILDIRIR, veriye dokunmaz (ilke 8). Bagimliliklar sayesinde duzelen kayit kendiliginden kapanir.

SELECT sistem.baglam_kur('kurulum', NULL, '0028_yeni_alan_dedektorleri', 'yeni alan dedektorleri');

INSERT INTO sistem.dedektor (kod, ad, varlik, onem, aciklama, cozum, sorgu, bagimlilik) VALUES

('D-IM-GENEL-GIDER-YALNIZ', 'İş merkezinde genel gider var, saat maliyeti yok', 'cekirdek.is_merkezi', 'uyari',
 'Genel gider oranı girilmiş ama saat maliyeti boş. Ürün maliyetinde genel gider görünür, işçilik hiç sayılmaz: maliyet olduğundan düşük çıkar.',
 'İş merkezine saat maliyetini girin ya da genel gider oranını kaldırın.',
 $q$SELECT m.id::text AS kayit_id,
          format('%s: genel gider %s/saat girilmiş ama saat maliyeti yok', m.kod, m.genel_gider_saat) AS mesaj,
          jsonb_build_object('genel_gider_saat', m.genel_gider_saat) AS ayrinti
   FROM cekirdek.is_merkezi m
   WHERE ($1::text[] IS NULL OR m.id::text = ANY ($1))
     AND m.aktif AND m.genel_gider_saat IS NOT NULL AND m.genel_gider_saat > 0 AND m.saat_maliyeti IS NULL$q$,
 $b$[{"tablo":"cekirdek.is_merkezi","kayit":"id"}]$b$),

('D-KUR-YOK', 'Tedarikçi fiyatı dövizli ama kuru yok', 'cekirdek.kalem', 'kritik',
 'Varsayılan tedarik koşulunun para birimi firmanınkinden farklı ve o para biriminin hiç kuru girilmemiş. Kalemin maliyeti ve o kalemden üretilen her şeyin maliyeti boş kalır.',
 'Kurulum → Veriler → Kurlar sayfasından kuru girin ya da koşulu firma para birimine çevirin.',
 $q$SELECT t.kalem_id::text AS kayit_id,
          format('%s: %s fiyatı için %s kuru hiç girilmemiş', k.kod, t.para_birimi, t.para_birimi) AS mesaj,
          jsonb_build_object('para_birimi', t.para_birimi) AS ayrinti
   FROM cekirdek.tedarik_kosulu t
   JOIN cekirdek.kalem k ON k.id = t.kalem_id
   WHERE ($1::text[] IS NULL OR t.kalem_id::text = ANY ($1))
     AND t.aktif AND t.varsayilan AND t.birim_fiyat IS NOT NULL
     AND t.para_birimi IS DISTINCT FROM (SELECT para_birimi FROM sistem.firma)
     AND NOT EXISTS (SELECT 1 FROM cekirdek.kur x WHERE x.para_birimi = t.para_birimi)$q$,
 $b$[
   {"tablo":"cekirdek.tedarik_kosulu","kayit":"kalem_id"},
   {"tablo":"cekirdek.kur","sorgu":"SELECT t.kalem_id::text FROM cekirdek.tedarik_kosulu t WHERE t.para_birimi = ($1->>'para_birimi')"}
 ]$b$),

('D-FASON-FIYAT-YOK', 'Fason adımının birim fiyatı yok', 'cekirdek.kalem', 'uyari',
 'Rotada dış tedarik (fason) adımı var ama adet başına fiyatı girilmemiş. Kalemin maliyeti boş kalır: fason bedeli sıfır sayılmaz.',
 'Rota adımına fason birim fiyatını girin (Kurulum → Veriler → Rotalar, "Fason fiyat" sütunu).',
 $q$SELECT r.kalem_id::text AS kayit_id,
          string_agg(format('%s. %s fason fiyatı yok', a.sira, o.kod), ' · ' ORDER BY a.sira) AS mesaj,
          jsonb_build_object('adimlar', jsonb_agg(a.id ORDER BY a.sira)) AS ayrinti
   FROM cekirdek.rota_adim a
   JOIN cekirdek.rota r ON r.id = a.rota_id AND r.durum = 'aktif'
   JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol = 'dis_tedarik'
   WHERE ($1::text[] IS NULL OR r.kalem_id::text = ANY ($1))
     AND a.dis_tedarik_birim_fiyat IS NULL
   GROUP BY r.kalem_id$q$,
 $b$[
   {"tablo":"cekirdek.rota","kayit":"kalem_id"},
   {"tablo":"cekirdek.rota_adim","sorgu":"SELECT kalem_id::text FROM cekirdek.rota WHERE id = ($1->>'rota_id')::uuid"},
   {"tablo":"cekirdek.operasyon","sorgu":"SELECT r.kalem_id::text FROM cekirdek.rota_adim a JOIN cekirdek.rota r ON r.id = a.rota_id WHERE a.operasyon_id = ($1->>'id')::uuid"}
 ]$b$),

('D-AGAC-ADIM-ASKIDA', 'Ağaç satırının adım sırası rotada yok', 'cekirdek.kalem', 'uyari',
 'Bileşene "adım sırası" yazılmış ama kalemin aktif rotasında o sırada adım yok. Fire bildiriminde o bileşen hiç düşülmez ya da yanlış adımda düşülür.',
 'Adım sırasını rotadaki bir sıraya eşitleyin ya da boş bırakın (boş = ilk adım).',
 $q$SELECT a.kalem_id::text AS kayit_id,
          string_agg(format('%s: adım %s rotada yok', b.kod, s.rota_adim_sira), ' · ' ORDER BY s.sira) AS mesaj,
          jsonb_build_object('satirlar', jsonb_agg(s.id ORDER BY s.sira)) AS ayrinti
   FROM cekirdek.urun_agaci_satir s
   JOIN cekirdek.urun_agaci a ON a.id = s.agac_id AND a.durum = 'aktif'
   JOIN cekirdek.kalem b ON b.id = s.bilesen_kalem_id
   WHERE ($1::text[] IS NULL OR a.kalem_id::text = ANY ($1))
     AND s.rota_adim_sira IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM cekirdek.rota r JOIN cekirdek.rota_adim ra ON ra.rota_id = r.id
       WHERE r.kalem_id = a.kalem_id AND r.durum = 'aktif' AND ra.sira = s.rota_adim_sira)
   GROUP BY a.kalem_id$q$,
 $b$[
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT kalem_id::text FROM cekirdek.urun_agaci WHERE id = ($1->>'agac_id')::uuid"},
   {"tablo":"cekirdek.rota","kayit":"kalem_id"},
   {"tablo":"cekirdek.rota_adim","sorgu":"SELECT kalem_id::text FROM cekirdek.rota WHERE id = ($1->>'rota_id')::uuid"}
 ]$b$),

('D-MUAYENE-SURESI-ASKIDA', 'Muayene süresi var ama giriş muayenesi kapalı', 'cekirdek.kalem', 'bilgi',
 'Kaleme muayene süresi yazılmış ama "giriş muayenesi gerekli" işaretli değil: mal kabulde lot karantinaya girmez, süre hiç kullanılmaz.',
 'Giriş muayenesini işaretleyin ya da süreyi kaldırın.',
 $q$SELECT k.id::text AS kayit_id,
          format('%s: muayene süresi %s iş günü yazılı ama giriş muayenesi kapalı', k.kod, k.ozellik->>'muayene_suresi_gun') AS mesaj,
          '{}'::jsonb AS ayrinti
   FROM cekirdek.kalem k
   WHERE ($1::text[] IS NULL OR k.id::text = ANY ($1))
     AND k.aktif AND (k.ozellik->>'muayene_suresi_gun')::numeric > 0
     AND COALESCE((k.ozellik->>'giris_muayenesi')::boolean, false) = false$q$,
 $b$[{"tablo":"cekirdek.kalem","kayit":"id"}]$b$);
`,K=`-- 0029 · KAPANMIS EMIRDE ACIK KALAN OPERASYON KAYDI
--
-- Kronometre baslatilip bitirilmeyen kayit maliyete girmez ve kapasitede "su an calisiliyor" gorunur.
-- Emir tamamlaninca (belge satiri 'tamam' / 'iptal') emir acik listeden duser; acik kayda EKRANDAN
-- ULASILAMAZ HALE GELIYORDU — ne bitirilebiliyor ne iptal edilebiliyordu. Sessiz, kalici bir kacak.
--
-- Dedektor kaydi isaret eder; Emirler ekraninda "Kapananlar dahil" ile emre ve kayda ulasilir.
-- Dedektor olay gudumludur (kayit ya da emir satiri degisince): saat gecince kendiliginden degismez,
-- bu yuzden "12 saatten uzun acik" gibi SAATE BAGLI bir kural BURADA DEGIL, ekranda okunurken hesaplanir
-- (ilke 5: canli ya da acikca bayat — saate bagli bulgu defterde bayatlar).

SELECT sistem.baglam_kur('kurulum', NULL, '0029_acik_kayit_kapali_emir', 'kapali emirde acik kayit dedektoru');

INSERT INTO sistem.dedektor (kod, ad, varlik, onem, aciklama, cozum, sorgu, bagimlilik) VALUES
('D-KAPALI-EMIRDE-ACIK-KAYIT', 'Kapanmış emirde açık operasyon kaydı', 'cekirdek.operasyon_kaydi', 'uyari',
 'Emir tamamlanmış ya da iptal edilmiş ama bu operasyon kaydının kronometresi hâlâ açık. Süresi maliyete girmez, kapasitede "çalışılıyor" görünür.',
 'Emirler ekranında "Kapananlar dahil"i açın, emrin Operasyonlar panelinden kaydı bitirin ya da açıklamayla iptal edin.',
 $q$SELECT ok.id::text AS kayit_id,
          format('%s · %s: %s tarihinden beri açık, emir %s', b.no, o.kod, to_char(ok.baslangic, 'DD.MM.YYYY HH24:MI'),
                 CASE s.durum WHEN 'tamam' THEN 'tamamlanmış' ELSE 'iptal' END) AS mesaj,
          jsonb_build_object('belge_satir_id', s.id, 'belge_no', b.no) AS ayrinti
   FROM cekirdek.operasyon_kaydi ok
   JOIN cekirdek.belge_satir s ON s.id = ok.belge_satir_id
   JOIN cekirdek.belge b ON b.id = s.belge_id
   JOIN cekirdek.operasyon o ON o.id = ok.operasyon_id
   WHERE ($1::text[] IS NULL OR ok.id::text = ANY ($1))
     AND NOT ok.iptal AND ok.bitis IS NULL AND ok.sure_dk IS NULL
     AND (s.durum IN ('tamam','iptal') OR b.durum IN ('tamam','iptal'))$q$,
 $b$[
   {"tablo":"cekirdek.operasyon_kaydi","kayit":"id"},
   {"tablo":"cekirdek.belge_satir","sorgu":"SELECT id::text FROM cekirdek.operasyon_kaydi WHERE belge_satir_id = ($1->>'id')::uuid AND bitis IS NULL AND sure_dk IS NULL"},
   {"tablo":"cekirdek.belge","sorgu":"SELECT ok.id::text FROM cekirdek.operasyon_kaydi ok JOIN cekirdek.belge_satir s ON s.id = ok.belge_satir_id WHERE s.belge_id = ($1->>'id')::uuid AND ok.bitis IS NULL AND ok.sure_dk IS NULL"}
 ]$b$);
`,W=`-- 0030 · DONEM MALIYETINDE URUNE OZEL AGAC VARYANTI
--
-- 0026 donem kaydi yalniz GENEL agactan hesapliyordu. Icerigi hangi urun icin yapildigina gore
-- degisen ara kalemin (0014) urune ozel maliyeti donemde YOKTU: yalniz urune ozel agaci olan ara
-- kalem "agac yok" diye bos gorunuyor, genel agaci da olan ara kalem ise YANLIS (genel) maliyetle
-- yaziliyordu. Mamulun kendi maliyeti dogruydu (patlatma koku tasir) ama ara kalemin parcasi okunamazdi.
--
--   kalem_maliyet.baglam_kalem_id : bos = genel agac; dolu = o KOK URUN icin yapilan varyant
--   Tekillik: (donem, kalem, baglam) — bos baglam da tekildir.
--   Karsilastirma (kalem, baglam) ciftiyle eslesir.
--   Standart maliyete yazma YALNIZ genel satirdan olur: kalem kartinda tek standart maliyet vardir.

SELECT sistem.baglam_kur('kurulum', NULL, '0030_donem_maliyeti_urune_ozel', 'donem maliyetinde urune ozel varyant');

ALTER TABLE cekirdek.kalem_maliyet ADD COLUMN baglam_kalem_id uuid REFERENCES cekirdek.kalem(id);
ALTER TABLE cekirdek.kalem_maliyet DROP CONSTRAINT kalem_maliyet_donem_id_kalem_id_key;
CREATE UNIQUE INDEX kalem_maliyet_tek ON cekirdek.kalem_maliyet
  (donem_id, kalem_id, COALESCE(baglam_kalem_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON COLUMN cekirdek.kalem_maliyet.baglam_kalem_id IS
  'Bos = genel agactan maliyet. Dolu = bu kok urun icin uretilen varyantin maliyeti (urune ozel agac, sema 0014).';

DROP FUNCTION cekirdek.maliyet_karsilastir(uuid, uuid);
CREATE FUNCTION cekirdek.maliyet_karsilastir(p_onceki uuid, p_sonraki uuid)
RETURNS TABLE (
  kalem_id uuid, kalem_kod text, kalem_ad text, baglam_kod text,
  onceki numeric, sonraki numeric, fark numeric,
  malzeme_fark numeric, iscilik_fark numeric, genel_gider_fark numeric, fason_fark numeric,
  onceki_eksik text, sonraki_eksik text
)
LANGUAGE sql STABLE AS $$
  SELECT k.id, k.kod, k.ad, bk.kod,
         a.birim_maliyet, b.birim_maliyet, b.birim_maliyet - a.birim_maliyet,
         b.malzeme - a.malzeme, b.iscilik - a.iscilik,
         COALESCE(b.genel_gider, 0) - COALESCE(a.genel_gider, 0), COALESCE(b.fason, 0) - COALESCE(a.fason, 0),
         a.eksik_neden, b.eksik_neden
  FROM (SELECT * FROM cekirdek.kalem_maliyet WHERE donem_id = p_onceki) a
  FULL JOIN (SELECT * FROM cekirdek.kalem_maliyet WHERE donem_id = p_sonraki) b
    ON b.kalem_id = a.kalem_id AND b.baglam_kalem_id IS NOT DISTINCT FROM a.baglam_kalem_id
  JOIN cekirdek.kalem k ON k.id = COALESCE(a.kalem_id, b.kalem_id)
  LEFT JOIN cekirdek.kalem bk ON bk.id = COALESCE(a.baglam_kalem_id, b.baglam_kalem_id)
  ORDER BY k.kod, bk.kod NULLS FIRST;
$$;
GRANT EXECUTE ON FUNCTION cekirdek.maliyet_karsilastir(uuid, uuid) TO authenticated;
`,G=`-- 0031 · STOK SAYIMI (sayim tutanagi -> sayim farki hareketi)
--
-- Belge turu 'sayim' ve hareket turu 'sayim_farki' 0005'ten beri vardi ama AKIS yoktu: defterdeki stok
-- ile raftaki stok ayrisinca duzeltmenin tek yolu elle SQL idi. MRP'nin her karari stok dogruluguna
-- dayanir; sayilamayan stok, sessizce yanlis siparis ve yanlis uretim demektir.
--
--   sayim_satir : sayim TUTANAGI. Sayim baslarken (kalem, depo, lot) basina SISTEM MIKTARI dondurulur
--                 (anlik goruntu); sayici SAYILAN miktari yazar.
--   Uygulama    : fark = sayilan − DONDURULAN sistem miktari. Fark sifir olmayan her satir icin bir belge
--                 satiri + 'sayim_farki' hareketi (isaretli). Tek islem grubu, geri alinir (ters kayit).
--
-- NEDEN DONDURULAN MIKTAR: sayim anindaki raf, o anki defterle karsilastirilir. Sayim bitince yapilan
-- sevk/uretim hareketleri GERCEKTIR ve sayimdan SONRA olmustur; fark guncel stoka gore alinsaydi
-- sayimdan sonra sevk edilen mal geri eklenirdi. Sayim sirasinda hareket gorulurse uygulama UYARIR.
--
-- Degerleme (cekirdek/degerleme.ts): arti fark guncel ortalama/standart maliyetle girer, eksi fark
-- ortalama/FIFO/lot maliyetiyle cikar — mevcut kural, degismedi.
-- Uygulanmis sayimin tutanagi degismez (kapi).

SELECT sistem.baglam_kur('kurulum', NULL, '0031_stok_sayimi', 'stok sayimi tutanagi');

-- Sayim ve transfer belgesi DEPOYU belge ozelliginde tasir (belge satirinda depo yok). Ozellik anahtari
-- katalogda tanimli olmali (0004 kapisi): sistem alani (sistem alani gorunur olmak zorunda).
-- Belgenin katalogu ilk kez aciliyor: varsayilansiz zorunlu kolonlar da katalogda olmali (0012 kapsam kurali).
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, secenekler, depolama, sistem_alani, gorunur, zorunlu) VALUES
  ('cekirdek.belge', 'tur', 'Belge türü', '{"en":"Document type"}', 'Kimlik', 10, 'liste',
   '[{"deger":"satis_siparisi","etiket":"Satış siparişi"},{"deger":"satinalma_siparisi","etiket":"Satın alma siparişi"},{"deger":"uretim_emri","etiket":"Üretim emri"},{"deger":"fason_emri","etiket":"Fason emri"},{"deger":"transfer","etiket":"Transfer"},{"deger":"sayim","etiket":"Sayım"},{"deger":"sevk","etiket":"Sevk"},{"deger":"mal_kabul","etiket":"Mal kabul"},{"deger":"acilis","etiket":"Açılış"}]',
   'kolon', true, true, true),
  ('cekirdek.belge', 'no', 'Belge no', '{"en":"Document no"}', 'Kimlik', 20, 'metin', NULL, 'kolon', true, true, true);

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu, aciklama) VALUES
  ('cekirdek.belge', 'depo_id', 'Sayılan depo', '{"en":"Counted warehouse"}', 'Depo', 10, 'iliski', 'cekirdek.depo', 'ozellik', true, true, false, 'Stok sayımı belgesinin deposu.'),
  ('cekirdek.belge', 'kaynak_depo_id', 'Kaynak depo', '{"en":"Source warehouse"}', 'Depo', 20, 'iliski', 'cekirdek.depo', 'ozellik', true, true, false, 'Transferde malın çıktığı depo.'),
  ('cekirdek.belge', 'hedef_depo_id', 'Hedef depo', '{"en":"Target warehouse"}', 'Depo', 30, 'iliski', 'cekirdek.depo', 'ozellik', true, true, false, 'Transferde malın girdiği depo.');

CREATE TABLE cekirdek.sayim_satir (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  belge_id        uuid NOT NULL REFERENCES cekirdek.belge(id) ON DELETE CASCADE,
  kalem_id        uuid NOT NULL REFERENCES cekirdek.kalem(id),
  depo_id         uuid NOT NULL REFERENCES cekirdek.depo(id),
  lot_id          uuid REFERENCES cekirdek.lot(id),
  sistem_miktari  numeric NOT NULL,
  sayilan         numeric CHECK (sayilan IS NULL OR sayilan >= 0),
  belge_satir_id  uuid REFERENCES cekirdek.belge_satir(id),
  olusturma       timestamptz NOT NULL DEFAULT now(),
  guncelleme      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sayim_satir_tek ON cekirdek.sayim_satir
  (belge_id, kalem_id, depo_id, COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid));
SELECT sistem.varlik_kaydet('cekirdek.sayim_satir');

COMMENT ON COLUMN cekirdek.sayim_satir.sistem_miktari IS 'Sayim baslarken defterdeki miktar (dondurulmus). Fark buna gore alinir.';
COMMENT ON COLUMN cekirdek.sayim_satir.sayilan IS 'Raftan sayilan miktar. Bos = sayilmadi (uygulamada fark yazilmaz).';

-- Uygulanmis (belgesi 'tamam') sayimin tutanagi degismez; geri alma (islem_geri_al) haric.
CREATE OR REPLACE FUNCTION cekirdek.sayim_satir_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_durum text; v_no text;
BEGIN
  SELECT durum, no INTO v_durum, v_no FROM cekirdek.belge WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.belge_id ELSE NEW.belge_id END;
  IF v_durum = 'tamam' AND COALESCE(sistem.baglam('kaynak'), '') <> 'geri_al'
     AND NOT (TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'belge_satir_id' - 'guncelleme') = (to_jsonb(OLD) - 'belge_satir_id' - 'guncelleme')) THEN
    RAISE EXCEPTION 'Sayim % uygulanmis: tutanagi degistirilemez.', v_no USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER b_kapi BEFORE INSERT OR UPDATE OR DELETE ON cekirdek.sayim_satir
FOR EACH ROW EXECUTE FUNCTION cekirdek.sayim_satir_kapisi();

-- ---------------------------------------------------------------------------
-- GERI AL: ayni islemde acilan BELGE SATIRI (ve belgesi) defterde geciyorsa silinmez (0021 lot kuralinin
-- genellemesi). Hareket ters kayitla dengelenir; satir silinmeye calisilsaydi stok_hareket FK'si
-- durdururdu ve sayim / hurda gibi belge acan islemler GERI ALINAMAZDI.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sistem.islem_geri_al(p_grup uuid, p_gerekce text DEFAULT NULL, p_zorla boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  o        sistem.olay%ROWTYPE;
  v_yeni_grup uuid;
  v_simdiki jsonb;
  v_sayi   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sistem.olay WHERE islem_grubu = p_grup) THEN
    RAISE EXCEPTION 'Islem grubu bulunamadi: %', p_grup;
  END IF;

  v_yeni_grup := sistem.baglam_kur('geri_al', sistem.baglam('kullanici'), p_grup::text,
                                   COALESCE(p_gerekce, 'islem grubu geri alindi'));

  FOR o IN SELECT * FROM sistem.olay WHERE islem_grubu = p_grup ORDER BY id DESC LOOP
    EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %I::text = $1', o.varlik, o.anahtar_alan)
      INTO v_simdiki USING o.kayit_id;

    IF o.islem = 'ekle' THEN
      IF v_simdiki IS NULL THEN CONTINUE; END IF;
      IF o.varlik = 'cekirdek.stok_hareket' THEN
        -- Defter: silinmez, ters kayitla dengelenir.
        IF EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE ters_hareket_id = o.kayit_id::uuid) THEN
          RAISE EXCEPTION 'Geri alinamaz: stok hareketi % zaten ters kayitla duzeltilmis.', o.kayit_id;
        END IF;
        PERFORM cekirdek.stok_hareket_ters_kayit(o.kayit_id::uuid, 'geri alındı: işlem ' || p_grup::text);
      ELSIF o.varlik = 'cekirdek.lot' AND EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE lot_id = o.kayit_id::uuid) THEN
        -- Lot defterde geciyor (asil + ters kayit): silinmez, stoku 0 olarak kalir.
        NULL;
      ELSIF o.varlik = 'cekirdek.belge_satir' AND EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE belge_satir_id = o.kayit_id::uuid) THEN
        -- 0031: ayni islemde acilan belge satiri defterde geciyor (asil + ters kayit): silinmez, net hareketi 0.
        NULL;
      ELSIF o.varlik = 'cekirdek.belge' AND EXISTS (
          SELECT 1 FROM cekirdek.stok_hareket h JOIN cekirdek.belge_satir s ON s.id = h.belge_satir_id WHERE s.belge_id = o.kayit_id::uuid) THEN
        NULL;
      ELSE
        EXECUTE format('DELETE FROM %s WHERE %I::text = $1', o.varlik, o.anahtar_alan) USING o.kayit_id;
      END IF;

    ELSIF o.islem = 'sil' THEN
      IF v_simdiki IS NOT NULL AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% silindikten sonra yeniden olusturulmus.', o.varlik, o.kayit_id;
      END IF;
      EXECUTE format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, $1)', o.varlik) USING o.eski;

    ELSE -- degistir
      IF v_simdiki IS NULL THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% artik yok.', o.varlik, o.kayit_id;
      END IF;
      IF (v_simdiki -> o.alan) IS DISTINCT FROM o.yeni AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/%.% bu islemden sonra degistirilmis (simdi %, islem %).',
          o.varlik, o.kayit_id, o.alan, v_simdiki -> o.alan, o.yeni;
      END IF;
      EXECUTE format(
        'UPDATE %1$s SET %2$I = (jsonb_populate_record(NULL::%1$s, $1)).%2$I WHERE %3$I::text = $2',
        o.varlik, o.alan, o.anahtar_alan)
        USING jsonb_build_object(o.alan, o.eski), o.kayit_id;
    END IF;
    v_sayi := v_sayi + 1;
  END LOOP;

  RETURN v_yeni_grup;
END $$;
`,P=`-- 0032 · SATIS TEKLIFI
--
-- Siparis dogrudan aciliyordu: teklif asamasi yoktu. Teklif verirken "bu fiyatla kazaniyor muyuz" sorusu
-- ancak siparis acildiktan sonra cevaplanabiliyordu; kaybedilen tekliflerin izi de tutulmuyordu.
--
--   belge turu 'satis_teklifi' (TK-): satirlar kalem, miktar, birim fiyat; belge para birimi, termin =
--   GECERLILIK tarihi. Durum: onayli (verildi) -> tamam (siparise dondu) | iptal (kaybedildi, gerekceli).
--
-- Teklif MRP'ye TALEP OLARAK GIRMEZ: cekirdek.belge_hareket_turu eslemesinde yoktur, dolayisiyla
-- belge_satir_kalan gorunumune hic girmez (MRP talep ve planli girisi oradan okur). Siparise
-- donusunce siparis talep olur; siparis teklife kaynak_belge_id ile baglidir.

SELECT sistem.baglam_kur('kurulum', NULL, '0032_satis_teklifi', 'satis teklifi');

ALTER TABLE cekirdek.belge DROP CONSTRAINT belge_tur_check;
ALTER TABLE cekirdek.belge ADD CONSTRAINT belge_tur_check CHECK (tur IN (
  'satis_siparisi','satinalma_siparisi','uretim_emri','fason_emri','transfer','sayim','sevk','mal_kabul','acilis','satis_teklifi'));

-- Katalogdaki liste (0031) ayni turleri tasir: kapi yeni turu reddetmesin.
UPDATE sistem.alan_tanim
   SET secenekler = secenekler || '[{"deger":"satis_teklifi","etiket":"Satış teklifi"}]'::jsonb
 WHERE varlik = 'cekirdek.belge' AND alan_kodu = 'tur'
   AND NOT secenekler @> '[{"deger":"satis_teklifi"}]'::jsonb;
`,$=`-- BAGLAM: auth semasina yetkisi olmayan rolde yazma dusmesin
--
-- Supabase'e ilk kurulumda bulundu (16 Eyl 2026): sistem.baglam('kullanici'), baglamda kullanici yoksa
-- auth.uid()'e bakiyordu. auth.uid() fonksiyonu VARSA ama calisan rolun auth semasina USAGE yetkisi
-- YOKSA (kurulum rolu, ileride sunucu islem katmaninin ozel rolu) cagri "permission denied for schema
-- auth" ile duser ve olay defteri tetikleyicisi yuzunden HER yazma geri alinir.
--
-- Duzeltme: auth.uid() yalniz calisan rol onu gercekten cagirabiliyorsa cagrilir. Cagiramiyorsa
-- kullanici bilinmiyor demektir -> NULL (sessiz varsayim yok: olay defterinde kullanici bos gorunur,
-- kaynak/gerekce baglamdan yine gelir). PGlite'ta auth yok; davranis degismez.

CREATE OR REPLACE FUNCTION sistem.baglam(p_anahtar text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text;
  v_basliklar jsonb;
BEGIN
  v := NULLIF(current_setting('uretim.' || p_anahtar, true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  BEGIN
    v_basliklar := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_basliklar := NULL;
  END;
  v := NULLIF(v_basliklar ->> ('x-uretim-' || replace(p_anahtar, '_', '-')), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  -- Ic ice IF bilerek: tek ifadede 'auth.uid()'::regprocedure planlamada cozulup yetki hatasi verir.
  IF p_anahtar = 'kullanici' AND to_regnamespace('auth') IS NOT NULL THEN
    IF has_schema_privilege(to_regnamespace('auth'), 'USAGE') THEN
      IF to_regprocedure('auth.uid()') IS NOT NULL THEN
        IF has_function_privilege(to_regprocedure('auth.uid()'), 'EXECUTE') THEN
          EXECUTE 'SELECT auth.uid()::text' INTO v;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN v;
END $$;
`,x=`-- DOGRULANMIS KULLANICI — sunucu islem katmaninin kimligi istemcinin soylediginin USTUNDEDIR
--
-- Sunucu (apps/uretim/src/veri/islem.ts: islemCalistir) her cagriyi tek islemde calistirir ve once
--   set_config('uretim.dogrulanmis_kullanici', <JWT'den gelen kullanici>, true)
-- yazar. Veri fonksiyonlari baglami istemciden gelen argumanla kurar (sistem.baglam_kur(..., p_kullanici, ...)).
-- Sunucu argumani zaten duzeltir; bu dosya IKINCI KAT: veritabani, dogrulanmis kimlik varken baska bir
-- kullanici adini olay defterine YAZDIRMAZ.
--
-- Dogrulanmis kimlik yoksa (PGlite, kurulum betigi, test) davranis 0033 ile aynidir.

CREATE OR REPLACE FUNCTION sistem.baglam_kur(
  p_kaynak      text,
  p_kullanici   text DEFAULT NULL,
  p_kaynak_ref  text DEFAULT NULL,
  p_gerekce     text DEFAULT NULL,
  p_islem_grubu uuid DEFAULT NULL,
  p_oturum_boyu boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_grup  uuid := COALESCE(p_islem_grubu, gen_random_uuid());
  v_yerel boolean := NOT p_oturum_boyu;
  v_kull  text := COALESCE(NULLIF(current_setting('uretim.dogrulanmis_kullanici', true), ''), p_kullanici, '');
BEGIN
  PERFORM set_config('uretim.kaynak',      p_kaynak, v_yerel);
  PERFORM set_config('uretim.kullanici',   v_kull, v_yerel);
  PERFORM set_config('uretim.kaynak_ref',  COALESCE(p_kaynak_ref, ''), v_yerel);
  PERFORM set_config('uretim.gerekce',     COALESCE(p_gerekce, ''), v_yerel);
  PERFORM set_config('uretim.islem_grubu', v_grup::text, v_yerel);
  RETURN v_grup;
END $$;

CREATE OR REPLACE FUNCTION sistem.baglam(p_anahtar text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text;
  v_basliklar jsonb;
BEGIN
  IF p_anahtar = 'kullanici' THEN
    v := NULLIF(current_setting('uretim.dogrulanmis_kullanici', true), '');
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  v := NULLIF(current_setting('uretim.' || p_anahtar, true), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  BEGIN
    v_basliklar := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_basliklar := NULL;
  END;
  v := NULLIF(v_basliklar ->> ('x-uretim-' || replace(p_anahtar, '_', '-')), '');
  IF v IS NOT NULL THEN RETURN v; END IF;
  -- Ic ice IF bilerek (0033): tek ifadede 'auth.uid()'::regprocedure planlamada cozulup yetki hatasi verir.
  IF p_anahtar = 'kullanici' AND to_regnamespace('auth') IS NOT NULL THEN
    IF has_schema_privilege(to_regnamespace('auth'), 'USAGE') THEN
      IF to_regprocedure('auth.uid()') IS NOT NULL THEN
        IF has_function_privilege(to_regprocedure('auth.uid()'), 'EXECUTE') THEN
          EXECUTE 'SELECT auth.uid()::text' INTO v;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN v;
END $$;
`,B=`-- KULLANICI, ROL, ISLEM IZNI — sunucu kipinde "kim hangi islemi cagirabilir" VERIDIR, kod degil.
--
-- Sunucu (apps/uretim/src/veri/islem.ts) her kayitli islemi bir TURLE kaydeder: okuma | yazma | yonetim.
-- Cagrilan islemin izni '<tur>:<islem adi>' (or. 'yazma:teklif.teklifOlustur'). Rol, izin KALIPLARI tutar:
--   '*'                 her sey
--   'okuma:*'           her okuma
--   'yazma:teklif.*'    teklif modulundeki her yazma
--   'yazma:planlama.malKabul'   tek islem
-- Kullanici (auth kimligi) bir ya da cok rol tasir. Kayitli ve aktif olmayan kullanici HIC bir islem cagiramaz
-- (sistem.izin_var NULL doner: "izin yok" ile "bu firmada kullanici degil" ayri mesajdir).
--
-- Tarayici kipinde (PGlite, tek kisi) izin denetimi yoktur; bu tablolar yalniz sunucu kipinde okunur.
-- Rol adlari alan kataloğundaki gorme_rolleri ile ayni sozluktur (0007: yonetici, planlama, satinalma, muhasebe).
--
-- Guvenlik kilitleri:
--   * roller listesinde olmayan rol kullaniciya verilemez; kullanicisi olan rol silinemez;
--   * izin kalibi bicimi denetlenir (yazim hatasi sessizce "izin yok" olmasin);
--   * her zaman EN AZ BIR aktif tam yetkili ('*') kullanici kalir (tek yonetici kendini kilitleyemez).
--     Ilk kurulumda (hic kullanici yokken) bu kural devrede degildir.

CREATE TABLE sistem.rol (
  kod        text PRIMARY KEY CHECK (kod ~ '^[a-z][a-z0-9_]*$'),
  ad         text NOT NULL,
  izinler    text[] NOT NULL DEFAULT '{}',
  aciklama   text,
  olusturma  timestamptz NOT NULL DEFAULT now(),
  guncelleme timestamptz NOT NULL DEFAULT now()   -- izin kalibi bicimi tetikleyicide denetlenir
);

CREATE TABLE sistem.kullanici (
  id         text PRIMARY KEY,                 -- sunucu kipinde auth kullanici kimligi (uuid metni)
  eposta     text,
  ad         text,
  roller     text[] NOT NULL DEFAULT '{}',
  aktif      boolean NOT NULL DEFAULT true,
  olusturma  timestamptz NOT NULL DEFAULT now(),
  guncelleme timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kullanici_eposta_tek ON sistem.kullanici (lower(eposta)) WHERE eposta IS NOT NULL;

SELECT sistem.varlik_kaydet('sistem.rol', 'kod');
SELECT sistem.varlik_kaydet('sistem.kullanici', 'id');
-- Yetki tablolarini yalniz sunucu (islem katmani) yazar; giris yapmis kullanici API'den yazamaz.
REVOKE INSERT, UPDATE, DELETE ON sistem.rol, sistem.kullanici FROM authenticated;

CREATE OR REPLACE FUNCTION sistem.rol_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM sistem.kullanici WHERE OLD.kod = ANY(roller)) THEN
      RAISE EXCEPTION 'Rol "%" silinemez: bu role sahip kullanıcı var.', OLD.kod USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  FOREACH i IN ARRAY NEW.izinler LOOP
    IF i !~ '^(\\*|(okuma|yazma|yonetim):(\\*|[A-Za-z][A-Za-z0-9]*(\\.(\\*|[A-Za-z][A-Za-z0-9]*))*))$' THEN
      RAISE EXCEPTION 'Rol "%": izin kalıbı geçersiz: "%". Biçim: * | okuma:* | yazma:modul.* | yonetim:modul.islem', NEW.kod, i
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER b_rol_kapisi BEFORE INSERT OR UPDATE OR DELETE ON sistem.rol
FOR EACH ROW EXECUTE FUNCTION sistem.rol_kapisi();

CREATE OR REPLACE FUNCTION sistem.kullanici_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY NEW.roller LOOP
    IF NOT EXISTS (SELECT 1 FROM sistem.rol WHERE kod = r) THEN
      RAISE EXCEPTION 'Kullanıcıya tanımsız rol verilemez: "%".', r USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  NEW.eposta := NULLIF(btrim(NEW.eposta), '');
  NEW.ad := NULLIF(btrim(NEW.ad), '');
  RETURN NEW;
END $$;
CREATE TRIGGER b_kullanici_kapisi BEFORE INSERT OR UPDATE ON sistem.kullanici
FOR EACH ROW EXECUTE FUNCTION sistem.kullanici_kapisi();

/** Kullanici kaydi yoksa ya da pasifse NULL; varsa izin kaliplarindan biri tutuyor mu. */
CREATE OR REPLACE FUNCTION sistem.izin_var(p_kullanici text, p_izin text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM sistem.kullanici WHERE id = p_kullanici AND aktif) THEN NULL
    ELSE EXISTS (
      SELECT 1
      FROM sistem.kullanici k
      JOIN sistem.rol r ON r.kod = ANY (k.roller)
      CROSS JOIN LATERAL unnest(r.izinler) AS i(kalip)
      WHERE k.id = p_kullanici
        AND (i.kalip = p_izin
             OR (right(i.kalip, 1) = '*' AND left(p_izin, length(i.kalip) - 1) = left(i.kalip, length(i.kalip) - 1))))
  END
$$;

/** En az bir aktif tam yetkili kullanici kalmali (kullanici hic yoksa -ilk kurulum- denetlenmez). */
CREATE OR REPLACE FUNCTION sistem.yonetici_kalmali()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM sistem.kullanici)
     AND NOT EXISTS (
       SELECT 1 FROM sistem.kullanici k JOIN sistem.rol r ON r.kod = ANY (k.roller)
       WHERE k.aktif AND '*' = ANY (r.izinler)) THEN
    RAISE EXCEPTION 'Bu değişiklik yapılamaz: firmada en az bir aktif tam yetkili (*) kullanıcı kalmalı.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_yonetici_kalmali AFTER UPDATE OR DELETE ON sistem.kullanici
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sistem.yonetici_kalmali();
CREATE CONSTRAINT TRIGGER z_yonetici_kalmali AFTER UPDATE OR DELETE ON sistem.rol
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sistem.yonetici_kalmali();

-- Baslangic rolleri: firma degistirebilir (veridir). Kisisel ayarlar (gorunum, tema) her rolde.
SELECT sistem.baglam_kur('kurulum', NULL, '0035_kullanici_rol_izin', 'baslangic rolleri');
INSERT INTO sistem.rol (kod, ad, izinler, aciklama) VALUES
  ('yonetici',  'Yönetici',  ARRAY['*'], 'Her işlem, kullanıcı ve rol yönetimi dahil.'),
  ('planlama',  'Planlama',  ARRAY['okuma:*', 'yazma:planlama.*', 'yazma:teklif.*', 'yazma:operasyon.*', 'yazma:depo.*', 'yazma:kalite.*',
                                   'yazma:sorgular.kayitKaydet', 'yazma:sorgular.islemGeriAl',
                                   'yazma:sorgular.gorunumKaydet', 'yazma:sorgular.gorunumSil', 'yazma:sorgular.temaKaydet'],
   'Sipariş, teklif, MRP, emir, depo, kalite.'),
  ('satinalma', 'Satın alma', ARRAY['okuma:*', 'yazma:planlama.onerileriBelgele', 'yazma:planlama.siparisTedarikciAta', 'yazma:planlama.malKabul',
                                   'yazma:tedarik.*', 'yazma:kalite.*', 'yazma:sorgular.islemGeriAl',
                                   'yazma:sorgular.gorunumKaydet', 'yazma:sorgular.gorunumSil', 'yazma:sorgular.temaKaydet'],
   'Satın alma siparişi, tedarikçi, mal kabul.'),
  ('muhasebe',  'Muhasebe',  ARRAY['okuma:*', 'yazma:maliyet.*', 'yazma:kur.*', 'yazma:sorgular.islemGeriAl',
                                   'yazma:sorgular.gorunumKaydet', 'yazma:sorgular.gorunumSil', 'yazma:sorgular.temaKaydet'],
   'Maliyet dönemleri, standart maliyet, kurlar.'),
  ('operator',  'Operatör',  ARRAY['okuma:*', 'yazma:operasyon.*', 'yazma:sorgular.islemGeriAl',
                                   'yazma:sorgular.gorunumKaydet', 'yazma:sorgular.gorunumSil', 'yazma:sorgular.temaKaydet'],
   'Operasyon kaydı (süre, miktar, fire).');
`,Y=`-- FONKSIYON ARAMA YOLU SABIT (Supabase guvenlik denetcisi: function_search_path_mutable, 44 uyari)
--
-- Arama yolu sabit olmayan fonksiyon, CAGIRANIN search_path'iyle calisir. Supabase'de giris yapmis rol
-- \`public\` semasina nesne olusturabilir; nitelenmemis bir ad (tablo, fonksiyon) oradaki sahte nesneye
-- cozulebilir. Onlem: her fonksiyonun arama yolu tanimda sabit.
--
--   * SECURITY INVOKER fonksiyonlar: search_path = ''  -> her ad nitelikli olmali (pg_catalog her zaman aranir).
--     Butun govdeler zaten sistem./cekirdek. nitelikli yazildi; testler bunu dogrular (nitelenmemis ad = hata).
--   * SECURITY DEFINER fonksiyonlar (0008, 0009): 'sistem, cekirdek, public, pg_temp' idi -> \`public\` cikarildi.
--     Tanimlayici haklariyla calisan fonksiyonun, herkesin yazabildigi semaya bakmasi asil acikti.
--
-- Yeni fonksiyon yazan migration arama yolunu kendisi verir: tests/yapi.test.js sabitsiz fonksiyon gorurse duser.

DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS imza, p.prosecdef AS tanimlayici
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('sistem', 'cekirdek') AND p.prokind = 'f'
  LOOP
    IF f.tanimlayici THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = sistem, cekirdek, pg_temp', f.imza);
    ELSE
      EXECUTE format('ALTER FUNCTION %s SET search_path = %L', f.imza, '');
    END IF;
  END LOOP;
END $$;
`,X=`-- 0037 · DURUS KAYDI ve PROBLEM TAKIBI
--
-- Operasyon kaydi (0022) calisilan sureyi tutar; CALISILAMAYAN sure hic yazilmiyordu. Makine arizasi,
-- malzeme beklemesi, ayar: kapasite "neden yetismedi" sorusunun cevabi defterde yoktu.
--
--   durus_nedeni : firma katalogu (kod, ad, planli/plansiz). Veridir; cekirdekte neden listesi YOK.
--   durus_kaydi  : bir IS MERKEZINDE (istenirse bir kaynakta, bir emir satirinda) calisilamayan sure.
--                  Operasyon kaydiyla ayni defter kurallari: acik kayit = bitis ve sure yok; kapanan kayit
--                  degismez, aciklamayla iptal edilir; silme yalniz islem geri almada.
--                  Ayni is merkezi + kaynak icin tek acik durus (ikinci "basladi" olamaz).
--   problem      : sahadan bildirilen sorun ve cozum takibi (acik -> inceleniyor -> cozuldu | iptal).
--                  Kapatmak icin cozum/kapanis notu zorunlu: "neden kapandi" ogrenilecek veridir.
--                  Durusa, emre, kaleme, is merkezine baglanabilir. Kapanis zamani tetikleyici yazar.
--
-- Rol izinleri (0035 roller veridir): operator durus girer ve problem acar; planlama ikisini de yonetir.
-- Durus nedeni katalogunu yonetmek 'yonetim:durus.*' (yalniz tam yetkili).

SELECT sistem.baglam_kur('kurulum', NULL, '0037_durus_problem', 'durus kaydi ve problem takibi');

CREATE TABLE cekirdek.durus_nedeni (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod         text NOT NULL UNIQUE,
  ad          text NOT NULL,
  tur         text NOT NULL DEFAULT 'plansiz' CHECK (tur IN ('planli','plansiz')),
  sira        integer NOT NULL DEFAULT 0,
  aktif       boolean NOT NULL DEFAULT true,
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN cekirdek.durus_nedeni.tur IS
  'planli: bakim, mola, ayar gibi onceden bilinen durus; plansiz: ariza, malzeme/operator bekleme. Raporda ayri toplanir.';
SELECT sistem.varlik_kaydet('cekirdek.durus_nedeni');

CREATE TABLE cekirdek.durus_kaydi (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_merkezi_id   uuid NOT NULL REFERENCES cekirdek.is_merkezi(id),
  kaynak_id       uuid REFERENCES cekirdek.kaynak(id),
  belge_satir_id  uuid REFERENCES cekirdek.belge_satir(id),
  neden_id        uuid NOT NULL REFERENCES cekirdek.durus_nedeni(id),
  baslangic       timestamptz NOT NULL DEFAULT clock_timestamp(),
  bitis           timestamptz,
  sure_dk         numeric CHECK (sure_dk IS NULL OR sure_dk >= 0),
  iptal           boolean NOT NULL DEFAULT false,
  aciklama        text,
  olusturma       timestamptz NOT NULL DEFAULT now(),
  guncelleme      timestamptz NOT NULL DEFAULT now(),
  CHECK (bitis IS NULL OR bitis >= baslangic)
);
CREATE INDEX durus_kaydi_merkez ON cekirdek.durus_kaydi (is_merkezi_id, baslangic);
CREATE UNIQUE INDEX durus_kaydi_tek_acik ON cekirdek.durus_kaydi
  (is_merkezi_id, COALESCE(kaynak_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE bitis IS NULL AND sure_dk IS NULL AND NOT iptal;
COMMENT ON COLUMN cekirdek.durus_kaydi.sure_dk IS
  'Elle girilen sure (dk). Bos = bitis − baslangic. Ikisi de yoksa durus suruyor (acik).';
SELECT sistem.varlik_kaydet('cekirdek.durus_kaydi');

CREATE OR REPLACE FUNCTION cekirdek.durus_kaydi_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tur text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(sistem.baglam('kaynak'), '') <> 'geri_al' THEN
      RAISE EXCEPTION 'Durus kaydi silinemez. Duzeltme icin kaydi iptal edip yenisini girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (OLD.bitis IS NOT NULL OR OLD.sure_dk IS NOT NULL)
       AND (to_jsonb(NEW) - 'iptal' - 'aciklama' - 'guncelleme') IS DISTINCT FROM (to_jsonb(OLD) - 'iptal' - 'aciklama' - 'guncelleme') THEN
      RAISE EXCEPTION 'Kapanmis durus kaydi degistirilemez; iptal edip yeni kayit girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.iptal AND NOT NEW.iptal THEN
      RAISE EXCEPTION 'Iptal edilmis durus kaydi geri acilamaz; yeni kayit girin.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.iptal AND NULLIF(btrim(COALESCE(NEW.aciklama, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Durus kaydi aciklamasiz iptal edilemez.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM cekirdek.durus_nedeni WHERE id = NEW.neden_id AND aktif) THEN
    RAISE EXCEPTION 'Durus nedeni aktif degil.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.belge_satir_id IS NOT NULL THEN
    SELECT b.tur INTO v_tur FROM cekirdek.belge_satir s JOIN cekirdek.belge b ON b.id = s.belge_id WHERE s.id = NEW.belge_satir_id;
    IF v_tur <> 'uretim_emri' THEN
      RAISE EXCEPTION 'Durus yalniz uretim emri satirina baglanir (belge turu: %).', v_tur USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION cekirdek.durus_kaydi_kapisi() SET search_path = '';
CREATE TRIGGER b_kapi BEFORE INSERT OR UPDATE OR DELETE ON cekirdek.durus_kaydi
FOR EACH ROW EXECUTE FUNCTION cekirdek.durus_kaydi_kapisi();

CREATE OR REPLACE VIEW cekirdek.durus_kaydi_v AS
SELECT d.id, d.is_merkezi_id, im.kod AS is_merkezi_kod, d.kaynak_id, kn.kod AS kaynak_kod, kn.ad AS kaynak_ad,
       d.belge_satir_id, b.no AS belge_no, k.kod AS kalem_kod,
       d.neden_id, n.kod AS neden_kod, n.ad AS neden_ad, n.tur AS neden_turu,
       d.baslangic, d.bitis, d.iptal, d.aciklama,
       CASE WHEN d.iptal THEN NULL
            ELSE COALESCE(d.sure_dk, EXTRACT(EPOCH FROM (d.bitis - d.baslangic)) / 60.0) END AS etkin_sure_dk
FROM cekirdek.durus_kaydi d
JOIN cekirdek.is_merkezi im ON im.id = d.is_merkezi_id
JOIN cekirdek.durus_nedeni n ON n.id = d.neden_id
LEFT JOIN cekirdek.kaynak kn ON kn.id = d.kaynak_id
LEFT JOIN cekirdek.belge_satir s ON s.id = d.belge_satir_id
LEFT JOIN cekirdek.belge b ON b.id = s.belge_id
LEFT JOIN cekirdek.kalem k ON k.id = s.kalem_id;
GRANT SELECT ON cekirdek.durus_kaydi_v TO authenticated;

-- ---------------------------------------------------------------------------
-- PROBLEM
-- ---------------------------------------------------------------------------
CREATE TABLE cekirdek.problem (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no              text NOT NULL UNIQUE,
  baslik          text NOT NULL CHECK (btrim(baslik) <> ''),
  aciklama        text,
  tur             text NOT NULL DEFAULT 'diger' CHECK (tur IN ('kalite','makine','malzeme','is_guvenligi','planlama','diger')),
  oncelik         text NOT NULL DEFAULT 'orta' CHECK (oncelik IN ('dusuk','orta','yuksek')),
  durum           text NOT NULL DEFAULT 'acik' CHECK (durum IN ('acik','inceleniyor','cozuldu','iptal')),
  bildiren        text NOT NULL,
  sorumlu         text,
  hedef_tarih     date,
  is_merkezi_id   uuid REFERENCES cekirdek.is_merkezi(id),
  kaynak_id       uuid REFERENCES cekirdek.kaynak(id),
  kalem_id        uuid REFERENCES cekirdek.kalem(id),
  belge_satir_id  uuid REFERENCES cekirdek.belge_satir(id),
  durus_kaydi_id  uuid REFERENCES cekirdek.durus_kaydi(id),
  kok_neden       text,
  cozum           text,
  kapanis         timestamptz,
  olusturma       timestamptz NOT NULL DEFAULT now(),
  guncelleme      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problem_durum ON cekirdek.problem (durum, olusturma);
COMMENT ON COLUMN cekirdek.problem.cozum IS 'Cozum ya da iptal gerekcesi. Kapatirken (cozuldu/iptal) zorunlu.';
SELECT sistem.varlik_kaydet('cekirdek.problem');

CREATE OR REPLACE FUNCTION cekirdek.problem_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(sistem.baglam('kaynak'), '') <> 'geri_al' THEN
      RAISE EXCEPTION 'Problem kaydi silinemez; gerekceyle iptal edin.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.no IS DISTINCT FROM OLD.no OR NEW.bildiren IS DISTINCT FROM OLD.bildiren) THEN
    RAISE EXCEPTION 'Problem numarasi ve bildiren degistirilemez.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.durum IN ('cozuldu','iptal') THEN
    IF NULLIF(btrim(COALESCE(NEW.cozum, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Problem % kapatilamaz: % icin not yazin.', NEW.no,
        CASE NEW.durum WHEN 'cozuldu' THEN 'cozum' ELSE 'iptal gerekcesi' END USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR OLD.durum NOT IN ('cozuldu','iptal') THEN NEW.kapanis := clock_timestamp(); END IF;
  ELSE
    NEW.kapanis := NULL;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION cekirdek.problem_kapisi() SET search_path = '';
CREATE TRIGGER b_kapi BEFORE INSERT OR UPDATE OR DELETE ON cekirdek.problem
FOR EACH ROW EXECUTE FUNCTION cekirdek.problem_kapisi();

-- ---------------------------------------------------------------------------
-- ROL IZINLERI (roller veridir: firma degistirdiyse rol yoksa dokunulmaz, var olan izin tekrar eklenmez)
-- ---------------------------------------------------------------------------
UPDATE sistem.rol r SET izinler = r.izinler || ARRAY(SELECT i FROM unnest(ARRAY['yazma:durus.*', 'yazma:problem.problemAc']) AS i WHERE i <> ALL (r.izinler))
WHERE r.kod = 'operator';
UPDATE sistem.rol r SET izinler = r.izinler || ARRAY(SELECT i FROM unnest(ARRAY['yazma:durus.*', 'yazma:problem.*']) AS i WHERE i <> ALL (r.izinler))
WHERE r.kod = 'planlama';
UPDATE sistem.rol SET aciklama = 'Operasyon kaydı (süre, miktar, fire), duruş kaydı, problem bildirimi.'
WHERE kod = 'operator' AND aciklama = 'Operasyon kaydı (süre, miktar, fire).';
`,j=`-- 0038 · KESIM AYARLARI (tek boyut kesim plani, cekirdek/kesim.ts)
--
-- Kesim plani uc olcuye bakar; ucu de firmaya ozgu sabit degil, KAYITTIR:
--   * is_merkezi.kesim_payi  : testere/disk agzi — kesen makineye bagli (lazerde ~0, serit testerede 2-3 mm).
--   * kalem.uc_kirpma        : yeni cubugun HER UCUNDAN kirpilan — malzemeye bagli (fabrika ucu, capak).
--   * kalem.min_artik        : bu boy ve ustu kalan artik stoka doner, alti hurdadir — malzemeye bagli.
-- Parca ve cubuk boyu mevcut katalog alani \`uzunluk\` (mm, 0007).
--
-- Bos birakilan ayar ekranda SIFIR diye gizlenmez: plan "tanimsiz, 0 alindi" diye yazar ve kullanici o hesap
-- icin degeri ekranda verebilir.

SELECT sistem.baglam_kur('kurulum', NULL, '0038_kesim_ayarlari', 'kesim plani ayarlari');

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, depolama, sistem_alani, gorunur, zorunlu, birim, aciklama) VALUES
  ('cekirdek.is_merkezi', 'kesim_payi', 'Kesim payı', '{"en":"Kerf"}', 'Kapasite', 40, 'sayi', 'ozellik', false, true, false, 'mm',
   'İki parça arasında kesim ağzının yediği boy (testere, disk). Kesim planı her iç kesim için düşer.'),
  ('cekirdek.kalem', 'uc_kirpma', 'Uç kırpma', '{"en":"End trim"}', 'Ölçü ve geometri', 90, 'sayi', 'ozellik', false, true, false, 'mm',
   'Yeni çubuğun her ucundan kırpılan boy (fabrika ucu, çapak). Artık çubukta uygulanmaz.'),
  ('cekirdek.kalem', 'min_artik', 'En küçük artık', '{"en":"Minimum usable offcut"}', 'Ölçü ve geometri', 100, 'sayi', 'ozellik', false, true, false, 'mm',
   'Kesimden kalan uç bu boy ve üstündeyse artık olarak stoğa döner, altındaysa hurdadır.');
`,J=`-- 0039 · FIRMA GUNU — zaman damgasindan gun, firmanin saat diliminde
--
-- Hata: "hangi gun" sorusu oturumun saat dilimiyle cevaplaniyordu (timestamptz::date, CURRENT_DATE).
-- Sunucu (Supabase) UTC calisir: Istanbul'da 00:00–03:00 arasi girilen operasyon kaydi, durus ve mal kabul
-- ONCEKI gune yaziliyordu; gece yarisindan sonra "bugun" hala dunku tarihti (son kullanma, belge tarihi).
-- Tarayici kipinde (PGlite) ayni kod bilgisayarin saatiyle calistigi icin hata yerelde gorunmuyordu.
--
-- Kural tek yerde: sistem.firma.saat_dilimi (0001'den beri var, varsayilan Europe/Istanbul).
--   sistem.firma_gunu(ts)  -> ts'nin firma saatindeki takvim gunu
--   sistem.firma_bugun()   -> islem anindaki firma gunu
-- Firma kaydi yoksa (yarim kurulum) oturumun saat dilimi kullanilir: eski davranis, sessiz degisiklik yok.
-- Gecersiz saat dilimi adi firma kaydina yazilamaz (kapi) — yoksa her gun hesabi calisma aninda patlardi.
--
-- Bu migration'la firma gunune gecenler: lot_durum (son kullanma gecti mi), tedarikci_performansi
-- (son mal kabul gunu), belge.tarih varsayilani. Ekran okumalari (fiili yuk, durus yuku/ozeti,
-- verimlilik tarih suzgeci, karantina tarihi, lot uretim/son kullanma) veri katmaninda ayni fonksiyonu cagirir.

SELECT sistem.baglam_kur('kurulum', NULL, '0039_firma_gunu', 'firma saat diliminde gun');

CREATE OR REPLACE FUNCTION sistem.firma_gunu(p_zaman timestamptz)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_zaman IS NULL THEN NULL
              ELSE COALESCE((p_zaman AT TIME ZONE (SELECT f.saat_dilimi FROM sistem.firma f WHERE f.tek))::date, p_zaman::date) END
$$;
ALTER FUNCTION sistem.firma_gunu(timestamptz) SET search_path = '';
COMMENT ON FUNCTION sistem.firma_gunu(timestamptz) IS
  'Zaman damgasinin firma saat dilimindeki takvim gunu (sistem.firma.saat_dilimi). Firma kaydi yoksa oturum saat dilimi.';

CREATE OR REPLACE FUNCTION sistem.firma_bugun()
RETURNS date LANGUAGE sql STABLE AS $$ SELECT sistem.firma_gunu(now()) $$;
ALTER FUNCTION sistem.firma_bugun() SET search_path = '';

CREATE OR REPLACE FUNCTION sistem.firma_saat_dilimi_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.saat_dilimi) THEN
    RAISE EXCEPTION 'Saat dilimi tanınmıyor: "%". Örnek: Europe/Istanbul, Europe/Berlin, UTC.', NEW.saat_dilimi
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION sistem.firma_saat_dilimi_kapisi() SET search_path = '';
CREATE TRIGGER b_saat_dilimi BEFORE INSERT OR UPDATE OF saat_dilimi ON sistem.firma
FOR EACH ROW EXECUTE FUNCTION sistem.firma_saat_dilimi_kapisi();

ALTER TABLE cekirdek.belge ALTER COLUMN tarih SET DEFAULT sistem.firma_bugun();

-- Gorunumler: kolonlar aynen, yalniz gun hesabi firma gunune.
CREATE OR REPLACE VIEW cekirdek.lot_durum AS
SELECT l.id AS lot_id, l.kalem_id, k.kod AS kalem_kod, l.lot_no, l.uretim_tarihi, l.son_kullanma,
       COALESCE(kk.karar, 'serbest') AS kalite_durumu, kk.zaman AS karar_zamani, kk.aciklama AS karar_aciklamasi,
       COALESCE(s.miktar, 0) AS stok, k.stok_birimi,
       CASE WHEN COALESCE(kk.karar, 'serbest') <> 'serbest' THEN COALESCE(kk.karar, 'serbest')
            WHEN l.son_kullanma < sistem.firma_bugun() THEN 'son_kullanma_gecti' END AS kullanilamaz_neden
FROM cekirdek.lot l
JOIN cekirdek.kalem k ON k.id = l.kalem_id
LEFT JOIN LATERAL (SELECT karar, zaman, aciklama FROM cekirdek.kalite_karari WHERE lot_id = l.id ORDER BY zaman DESC LIMIT 1) kk ON true
LEFT JOIN LATERAL (SELECT sum(miktar) AS miktar FROM cekirdek.stok_hareket WHERE lot_id = l.id) s ON true;

CREATE OR REPLACE VIEW cekirdek.tedarikci_performansi AS
WITH teslim AS (
  SELECT b.partner_id, s.id AS satir_id, s.termin,
         max(sistem.firma_gunu(h.zaman)) AS son_kabul
  FROM cekirdek.belge b
  JOIN cekirdek.belge_satir s ON s.belge_id = b.id
  JOIN cekirdek.stok_hareket h ON h.belge_satir_id = s.id AND h.tur = 'mal_kabul'
  WHERE b.tur = 'satinalma_siparisi' AND b.partner_id IS NOT NULL AND s.durum = 'tamam' AND s.termin IS NOT NULL
  GROUP BY b.partner_id, s.id, s.termin
)
SELECT p.id AS partner_id, p.kod, p.ad,
       count(t.satir_id)::int AS teslim_satiri,
       count(t.satir_id) FILTER (WHERE t.son_kabul <= t.termin)::int AS zamaninda,
       CASE WHEN count(t.satir_id) > 0 THEN round(100.0 * count(t.satir_id) FILTER (WHERE t.son_kabul <= t.termin) / count(t.satir_id), 1) END AS zamaninda_yuzde,
       round(avg(GREATEST(t.son_kabul - t.termin, 0)) FILTER (WHERE t.son_kabul > t.termin), 1) AS ortalama_gecikme_gun
FROM cekirdek.partner p
LEFT JOIN teslim t ON t.partner_id = p.id
WHERE p.roller && ARRAY['tedarikci','fasoncu']
GROUP BY p.id, p.kod, p.ad;
`,q=`-- 0040 · ARTIK HAVUZU (1. asama) — kesimden kalan kullanilabilir cubuk/levha parcasi olcusuyle stokta izlenir.
--
-- Ayri tablo YOK (ilke 1): artik, ham kalemin bir LOT'udur. Olcusu lot.ozellik'te:
--   * cubuk (tek boyut): uzunluk (mm)
--   * levha (iki boyut): en + boy (mm)
-- Stok miktari ham kalemin stok biriminde defter hareketidir (belge 'sayim' AR-xxxxx, hareket 'sayim_farki').
-- Kalite durumu, son kullanma, depo, transfer ve geri alma lotun mevcut kurallarini kullanir.
-- Kesim plani (apps/uretim veri/kesim.ts) kullanilabilir artik lotlarini yeni stoktan ONCE kullanir.
--
-- Kesim bildiriminde otomatik artik yazimi 2. asamadir (burada yok).

SELECT sistem.baglam_kur('kurulum', NULL, '0040_artik_havuzu', 'artik havuzu: lot olculeri');

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, depolama, sistem_alani, gorunur, zorunlu, birim, min_deger, aciklama) VALUES
  ('cekirdek.lot', 'uzunluk', 'Uzunluk', '{"en":"Length"}', 'Ölçü', 10, 'sayi', 'ozellik', false, true, false, 'mm', 0,
   'Artık çubuğun boyu. Doluysa lot kesim planında artık çubuk olarak kullanılır.'),
  ('cekirdek.lot', 'en', 'En', '{"en":"Width"}', 'Ölçü', 20, 'sayi', 'ozellik', false, true, false, 'mm', 0,
   'Artık levhanın eni. En ve boy doluysa lot kesim planında artık levha olarak kullanılır.'),
  ('cekirdek.lot', 'boy', 'Boy', '{"en":"Length"}', 'Ölçü', 30, 'sayi', 'ozellik', false, true, false, 'mm', 0,
   'Artık levhanın boyu.');

-- Katalogu olan varlikta varsayilansiz zorunlu kolonlar da katalogda olmali (tests/katalog_kapsami).
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu) VALUES
  ('cekirdek.lot', 'kalem_id', 'Kalem', '{"en":"Item"}', 'Kimlik', 1, 'iliski', 'cekirdek.kalem', 'kolon', true, true, true),
  ('cekirdek.lot', 'lot_no', 'Lot no', '{"en":"Lot no"}', 'Kimlik', 2, 'metin', NULL, 'kolon', true, true, true);

-- Rol izinleri (0035 roller veridir): artik girisini planlama yapar.
UPDATE sistem.rol r SET izinler = r.izinler || ARRAY(SELECT i FROM unnest(ARRAY['yazma:artik.*']) AS i WHERE i <> ALL (r.izinler))
WHERE r.kod = 'planlama';
`,V=`-- 0041 · AGACTA KULLANILAN AMA AGACSIZ URETILEN KALEM
--
-- D-URETILEN-AGACSIZ (0008) aktif agaci olmayan HER uretilen kalemi uyarir. Gercek veride (Ozler pilotu, 17 Eyl)
-- 4.500 bulgu verdi: 2.998 mamulun ve 1.460 yari mamulun eski sistemde hic recetesi yok ve hicbir yerde
-- kullanilmiyor (kullanilmayan kart). Bu kalabaligin icinde 15 kalem baska bir urunun AKTIF agacinda bilesen
-- olarak geciyor ama kendi agaci yok: MRP o urunu patlatirken bu kalemin altina inemez, malzeme ihtiyaci eksik
-- cikar. Asil hata onlar; genel uyari listesinde gorunmuyorlardi.
--
-- Yeni dedektor YALNIZ kullanilanlari isaret eder, onemi KRITIK. Genel uyari (kullanilmayan kart) yerinde kalir.

SELECT sistem.baglam_kur('kurulum', NULL, '0041_agacta_kullanilan_agacsiz', 'agacta kullanilan agacsiz kalem dedektoru');

INSERT INTO sistem.dedektor (kod, ad, varlik, onem, aciklama, cozum, sorgu, bagimlilik) VALUES
('D-AGACTA-KULLANILAN-AGACSIZ', 'Ağaçta bileşen olan üretilen kalemin ağacı yok', 'cekirdek.kalem', 'kritik',
 'Bu kalem en az bir ürünün aktif ağacında bileşen olarak geçiyor, kendisi üretiliyor (mamul/yarı mamul) ama aktif ağacı yok. MRP bu kalemin altındaki malzeme ihtiyacını hesaplayamaz; üst ürünün malzeme listesi eksik çıkar.',
 'Kalemin ürün ağacını tanımlayın; satın alınıyorsa ya da fasoncudan hazır geliyorsa kartta "hazır alınır" işaretleyin.',
 $q$SELECT k.id::text AS kayit_id,
          format('%s (%s) %s ürünün ağacında bileşen ama kendi aktif ağacı yok (örnek: %s)', k.kod, k.tip, u.sayi, u.ornek) AS mesaj,
          jsonb_build_object('kullanan_urun_sayisi', u.sayi, 'ornek', u.ornek) AS ayrinti
   FROM cekirdek.kalem k
   JOIN LATERAL (
     SELECT count(DISTINCT a.kalem_id)::int AS sayi, min(ust.kod) AS ornek
     FROM cekirdek.urun_agaci_satir s
     JOIN cekirdek.urun_agaci a ON a.id = s.agac_id AND a.durum = 'aktif'
     JOIN cekirdek.kalem ust ON ust.id = a.kalem_id
     WHERE s.bilesen_kalem_id = k.id
   ) u ON u.sayi > 0
   WHERE ($1::text[] IS NULL OR k.id::text = ANY ($1))
     AND k.aktif AND k.tip IN ('mamul','yari_mamul')
     AND COALESCE((k.ozellik ->> 'hazir_alinir')::boolean, false) = false
     AND COALESCE((k.ozellik ->> 'fantom')::boolean, false) = false
     AND NOT EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif')$q$,
 $b$[
   {"tablo":"cekirdek.kalem","kayit":"id"},
   {"tablo":"cekirdek.urun_agaci","sorgu":"SELECT ($1->>'kalem_id') UNION SELECT s.bilesen_kalem_id::text FROM cekirdek.urun_agaci_satir s WHERE s.agac_id = ($1->>'id')::uuid"},
   {"tablo":"cekirdek.urun_agaci_satir","kayit":"bilesen_kalem_id"}
 ]$b$);
`,w=`-- 0042 · KULLANICI ↔ KAYNAK
--
-- Saha (operator paneli) "Ben" secimini her cihazda listeden istiyordu. Pilot firmada 106 operator var;
-- telefonda listeden aramak pratik degil, yanlis kisi secilince kayit baskasina yazilir.
--
--   sistem.kullanici.kaynak_id : oturum hesabinin sahada hangi kaynak (operator/makine) oldugu.
--   Bir kaynak en cok bir kullaniciya baglanir (iki hesap ayni operatorun adina kayit acmasin).
--   Pasif kaynak baglanamaz. Baglama zorunlu degil: makine kaynaklari ve ortak saha tableti baglanmaz.
--
-- Ekran: baglantisi olan kullanicida Saha "Ben" bu kaynakla gelir ve kilitlidir (veri/kullanici.benim).

SELECT sistem.baglam_kur('kurulum', NULL, '0042_kullanici_kaynak', 'kullanici kaynak baglantisi');

ALTER TABLE sistem.kullanici ADD COLUMN kaynak_id uuid REFERENCES cekirdek.kaynak(id);
CREATE UNIQUE INDEX kullanici_kaynak_tek ON sistem.kullanici (kaynak_id) WHERE kaynak_id IS NOT NULL;
COMMENT ON COLUMN sistem.kullanici.kaynak_id IS
  'Sahada bu hesabin temsil ettigi kaynak (operator/makine). Bos = baglanmamis (Saha''da kaynak elle secilir).';

CREATE OR REPLACE FUNCTION sistem.kullanici_kaynak_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kaynak_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.kaynak_id IS DISTINCT FROM OLD.kaynak_id)
     AND NOT EXISTS (SELECT 1 FROM cekirdek.kaynak WHERE id = NEW.kaynak_id AND aktif) THEN
    RAISE EXCEPTION 'Pasif kaynak kullanıcıya bağlanamaz.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION sistem.kullanici_kaynak_kapisi() SET search_path = '';
CREATE TRIGGER b_kaynak_kapisi BEFORE INSERT OR UPDATE OF kaynak_id ON sistem.kullanici
FOR EACH ROW EXECUTE FUNCTION sistem.kullanici_kaynak_kapisi();
`,Z=`-- 0043 · AGACSIZ DEDEKTORU PLANLANMAZ KALEMI SAYMAZ + 0041 SUZGECI INDEKS KULLANSIN
--
-- 1) D-URETILEN-AGACSIZ, planlama yontemi 'planlanmaz' olan kalemi de uyariyordu. Planlanmaz kalemi MRP hic
--    planlamaz (ihtiyac cikarsa ayrica PLANLANMAZ_IHTIYAC uyarisi verir), agaca ihtiyaci yoktur. Ozler pilotu
--    (17 Eyl, Serdar karari): eski sistemde recetesi olmayan 2.998 mamul planlanmaz isaretlendi; recete
--    olustukca aktarim onu yeniden MRP'ye alir. Bu kalemler icin "agac yok" uyarisi gurultudur.
--    Baska urunun agacinda bilesen olan agacsiz kalem ise planlanmaz olsa da D-AGACTA-KULLANILAN-AGACSIZ'de
--    (kritik) kalir: ust urunun malzeme listesi yine eksik cikar.
-- 2) 0041'deki D-AGACTA-KULLANILAN-AGACSIZ kayit suzgeci "k.id::text = ANY ($1)" yazilmisti: 0013'te olculen
--    O(n²) kalibi (kolon metne cevrilince birincil anahtar indeksi kullanilmaz). Dizi uuid'e cevrilir.

SELECT sistem.baglam_kur('kurulum', NULL, '0043_agacsiz_planlanmaz_haric', 'agacsiz dedektoru planlanmaz haric');

DO $$
DECLARE
  r record;
  v_yeni text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('D-URETILEN-AGACSIZ', 'AND k.aktif AND k.tip IN (''mamul'',''yari_mamul'')',
                             'AND k.aktif AND k.tip IN (''mamul'',''yari_mamul'') AND k.planlama_yontemi <> ''planlanmaz'''),
      ('D-AGACTA-KULLANILAN-AGACSIZ', 'k.id::text = ANY ($1)', 'k.id = ANY ($1::uuid[])')
    ) AS x(kod, eski, yeni)
  LOOP
    SELECT replace(sorgu, r.eski, r.yeni) INTO v_yeni FROM sistem.dedektor WHERE kod = r.kod AND position(r.eski IN sorgu) > 0;
    IF v_yeni IS NULL THEN
      RAISE EXCEPTION '0043: % sorgusunda beklenen metin (%) bulunamadi.', r.kod, r.eski;
    END IF;
    UPDATE sistem.dedektor SET sorgu = v_yeni WHERE kod = r.kod;
  END LOOP;
END $$;

-- Bagimlilik: planlama yontemi kalem kolonudur; kalem zaten izleniyor (0008), ek bagimlilik gerekmez.
`,Q=`-- 0044 · IS MERKEZI TAKVIMI — onceden bilinen kapali sure (planli bakim, ariza onarimi, ayar, egitim)
--
-- Takvim (0005 takvim_gun) FIRMA genelidir: tatil, yarim gun. "KES tezgahi 22 Eylul'de 4 saat bakimda"
-- girilemiyordu; kapasite cizelgesi o gun tezgahi tam kapasite sayiyor, termin tahmini iyimser cikiyordu.
--
--   is_merkezi_takvim : is merkezi + gun basina TEK satir. kapali_dk bos = butun gun kapali; dolu = o gunun
--                       kapasitesinden dusulen dakika (en az 0 kalir). Firma takvimi (tatil/yarim gun) once uygulanir.
--   Plan ile gerceklesen ayridir: gun gelince sahada durus kaydi (0037) girilir; bu tablo PLANDIR, defter degil
--   (silinebilir/degistirilebilir, olay defterinden geri alinir).
--
-- Rol: planlama bu takvimi yazar (yazma:takvim.*).

SELECT sistem.baglam_kur('kurulum', NULL, '0044_is_merkezi_takvim', 'is merkezi planli kapali sure');

CREATE TABLE cekirdek.is_merkezi_takvim (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_merkezi_id  uuid NOT NULL REFERENCES cekirdek.is_merkezi(id),
  tarih          date NOT NULL,
  kapali_dk      numeric CHECK (kapali_dk IS NULL OR kapali_dk > 0),
  neden          text NOT NULL DEFAULT 'bakim' CHECK (neden IN ('bakim','ariza_onarimi','ayar','egitim','diger')),
  aciklama       text,
  olusturma      timestamptz NOT NULL DEFAULT now(),
  guncelleme     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (is_merkezi_id, tarih)
);
COMMENT ON COLUMN cekirdek.is_merkezi_takvim.kapali_dk IS
  'O gun kapasiteden dusulen dakika. Bos = butun gun kapali.';
SELECT sistem.varlik_kaydet('cekirdek.is_merkezi_takvim');

UPDATE sistem.rol r SET izinler = r.izinler || ARRAY(SELECT i FROM unnest(ARRAY['yazma:takvim.*']) AS i WHERE i <> ALL (r.izinler))
WHERE r.kod = 'planlama';
`,ii=`-- 0045 · KOD SABLONUNUN TIP KAPSAMI
--
-- Kod sablonu kurali (K-KOD-SABLON) firmanin kod duzenini tarif eder. Bircok firmada bu duzen yalniz URETILEN
-- kalemler icindir: satin alinan hammadde/sarf, tedarikcinin ya da eski sistemin koduyla gelir ve firma kurali
-- onlar icin hic tanimlanmamistir. D-KALEM-KOD-SABLONU ise her tipi denetliyordu. Ozler pilotu (17 Eyl):
-- 795 bulgunun ~600'u sablonu hic tanimlanmamis hammadde/sarf kodu — gurultu; gercek bulgu (uyumsuz mamul ve
-- yari mamul kodu) aralarinda kayboluyordu.
--
-- Kural tanimi ISTEGE BAGLI "tipler" alani tasir: {"desenler":[...], "tipler":["mamul","yari_mamul"]}
--   * alan yoksa eski davranis: her tip denetlenir;
--   * alan varsa yalniz listedeki tipler denetlenir (kalem.tip degerleri).
-- Kod cozme (sistem.kod_coz) degismez: kapsam disi bir kodu cozmeye calismak yine NULL doner.

SELECT sistem.baglam_kur('kurulum', NULL, '0045_kod_sablonu_tip_kapsami', 'kod sablonu tip kapsami');

-- Kural yoksa kod_coz HATA verir: kosul sirasina guvenilmez (planlayici once kod_coz'u calistirabilir), CASE ile korunur.
DO $$
DECLARE
  v_kural_eski text := 'AND EXISTS (SELECT 1 FROM sistem.kural r WHERE r.kod = ''K-KOD-SABLON'' AND r.durum = ''aktif'')';
  v_kural_yeni text := 'AND CASE WHEN EXISTS (SELECT 1 FROM sistem.kural r WHERE r.kod = ''K-KOD-SABLON'' AND r.durum = ''aktif'' AND (NOT (r.tanim ? ''tipler'') OR k.tip IN (SELECT jsonb_array_elements_text(r.tanim -> ''tipler'')))) THEN';
  v_coz_eski text := 'AND sistem.kod_coz(k.kod, ''K-KOD-SABLON'') IS NULL';
  v_coz_yeni text := 'sistem.kod_coz(k.kod, ''K-KOD-SABLON'') IS NULL ELSE false END';
  v_sorgu text;
BEGIN
  SELECT sorgu INTO v_sorgu FROM sistem.dedektor WHERE kod = 'D-KALEM-KOD-SABLONU';
  IF position(v_kural_eski IN v_sorgu) = 0 OR position(v_coz_eski IN v_sorgu) = 0 THEN
    RAISE EXCEPTION '0045: D-KALEM-KOD-SABLONU sorgusunda beklenen kosullar bulunamadi.';
  END IF;
  UPDATE sistem.dedektor SET sorgu = replace(replace(v_sorgu, v_kural_eski, v_kural_yeni), v_coz_eski, v_coz_yeni)
  WHERE kod = 'D-KALEM-KOD-SABLONU';
END $$;
`,ai=`-- 0046 · BOLUM → OPERASYON → ISTASYON, OPERATORUN CALISABILECEGI ISTASYONLAR
--
-- Firma yapisi (Ozler pilotu, Serdar karari 17 Eyl): "pres bolumu var, altinda operasyonlar var, altinda is
-- istasyonlari olacak. Operatorler kendi bolumlerinde secilmediyse tum istasyonlarda calisabilir. Bir operator
-- birden fazla istasyon ve bolumde calisabilir. Bir operasyon da birden fazla bolumde yapilabilir."
-- Once kurgu; veri sonra duzelir. Onceki model: bolum is_merkezi.ozellik icinde serbest metin, kaynak tek is
-- merkezine bagli — coka-cok iliskiyi tasiyamiyordu.
--
--   cekirdek.bolum               : bolum karti (kod, ad).
--   is_merkezi.bolum_id          : istasyon (is merkezi) fiziksel olarak TEK bolumdedir; bos olabilir.
--   cekirdek.bolum_operasyon     : bolumde yapilan operasyonlar (coka-cok).
--   cekirdek.operasyon_is_merkezi: operasyonun yapilabildigi istasyonlar (coka-cok).
--   cekirdek.kaynak_bolum        : operatorun calistigi bolumler (coka-cok).
--   cekirdek.kaynak_is_merkezi   : operatorun secilmis istasyonlari (coka-cok).
--
-- Kural (gorunumler hesaplar, ekran ve saha ayni kurali kullanir):
--   kaynak_calisabilir_istasyon_v  — kaynagin calisabilecegi aktif istasyonlar ve NEDENI:
--     * 'istasyon' : acikca secilmis istasyon (kaynak.is_merkezi_id de secim sayilir: makine kendi yerindedir);
--     * 'bolum'    : kaynagin bolumundeki istasyon — o bolumde istasyon secimi YOKSA bolumun tum istasyonlari;
--                    secim varsa o bolumde yalniz secilenler;
--     * 'tum'      : kaynagin ne bolumu ne istasyon secimi var → tum aktif istasyonlar.
--   operasyon_yapilabilir_istasyon_v — operasyonun yapilabildigi aktif istasyonlar ve NEDENI:
--     * 'istasyon' : acikca secilmis; yoksa
--     * 'bolum'    : operasyonun bolumlerindeki istasyonlar; yoksa
--     * 'varsayilan': operasyon kartindaki varsayilan is merkezi; o da yoksa
--     * 'tum'      : tum aktif istasyonlar.
-- Tutarsizlik (istasyonun bolumu operasyonu listelemiyor vb.) yazimi engellemez: veri duzeltilirken kurgu
-- kilitlenmesin. Denetim gerekirse dedektor olarak eklenir.
--
-- Uyum: is_merkezi.ozellik.bolum (0007, serbest metin) artik yazilirsa bolum kartina cevrilir (yoksa acilir) ve
-- bolum_id'ye yazilir; ozellikten silinir. Eski dosya/paket bozulmaz. Katalogda metin alani gizlenir, yerine
-- bolum_id (iliski) gelir.

SELECT sistem.baglam_kur('kurulum', NULL, '0046_bolum_istasyon', 'bolum operasyon istasyon modeli');

CREATE TABLE cekirdek.bolum (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod         text NOT NULL UNIQUE,
  ad          text NOT NULL,
  aktif       boolean NOT NULL DEFAULT true,
  ozellik     jsonb NOT NULL DEFAULT '{}',
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now()
);
SELECT sistem.varlik_kaydet('cekirdek.bolum');

ALTER TABLE cekirdek.is_merkezi ADD COLUMN bolum_id uuid REFERENCES cekirdek.bolum(id);
CREATE INDEX is_merkezi_bolum ON cekirdek.is_merkezi (bolum_id) WHERE bolum_id IS NOT NULL;

CREATE TABLE cekirdek.bolum_operasyon (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bolum_id      uuid NOT NULL REFERENCES cekirdek.bolum(id) ON DELETE CASCADE,
  operasyon_id  uuid NOT NULL REFERENCES cekirdek.operasyon(id) ON DELETE CASCADE,
  olusturma     timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bolum_id, operasyon_id)
);
CREATE INDEX bolum_operasyon_operasyon ON cekirdek.bolum_operasyon (operasyon_id);
SELECT sistem.varlik_kaydet('cekirdek.bolum_operasyon');

CREATE TABLE cekirdek.operasyon_is_merkezi (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operasyon_id   uuid NOT NULL REFERENCES cekirdek.operasyon(id) ON DELETE CASCADE,
  is_merkezi_id  uuid NOT NULL REFERENCES cekirdek.is_merkezi(id) ON DELETE CASCADE,
  olusturma      timestamptz NOT NULL DEFAULT now(),
  guncelleme     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operasyon_id, is_merkezi_id)
);
CREATE INDEX operasyon_is_merkezi_im ON cekirdek.operasyon_is_merkezi (is_merkezi_id);
SELECT sistem.varlik_kaydet('cekirdek.operasyon_is_merkezi');

CREATE TABLE cekirdek.kaynak_bolum (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kaynak_id   uuid NOT NULL REFERENCES cekirdek.kaynak(id) ON DELETE CASCADE,
  bolum_id    uuid NOT NULL REFERENCES cekirdek.bolum(id) ON DELETE CASCADE,
  olusturma   timestamptz NOT NULL DEFAULT now(),
  guncelleme  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kaynak_id, bolum_id)
);
CREATE INDEX kaynak_bolum_bolum ON cekirdek.kaynak_bolum (bolum_id);
SELECT sistem.varlik_kaydet('cekirdek.kaynak_bolum');

CREATE TABLE cekirdek.kaynak_is_merkezi (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kaynak_id      uuid NOT NULL REFERENCES cekirdek.kaynak(id) ON DELETE CASCADE,
  is_merkezi_id  uuid NOT NULL REFERENCES cekirdek.is_merkezi(id) ON DELETE CASCADE,
  olusturma      timestamptz NOT NULL DEFAULT now(),
  guncelleme     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kaynak_id, is_merkezi_id)
);
CREATE INDEX kaynak_is_merkezi_im ON cekirdek.kaynak_is_merkezi (is_merkezi_id);
SELECT sistem.varlik_kaydet('cekirdek.kaynak_is_merkezi');

-- Uyum: ozellik.bolum metni -> bolum karti. b_ozellik_dogrula'dan ONCE calisir (trigger ad sirasi).
CREATE OR REPLACE FUNCTION cekirdek.is_merkezi_bolum_metni()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_metin text := nullif(btrim(NEW.ozellik ->> 'bolum'), '');
  v_id uuid;
BEGIN
  IF NEW.ozellik ? 'bolum' THEN
    IF v_metin IS NOT NULL AND NEW.bolum_id IS NULL THEN
      SELECT id INTO v_id FROM cekirdek.bolum WHERE lower(kod) = lower(v_metin) OR lower(ad) = lower(v_metin)
      ORDER BY (lower(kod) = lower(v_metin)) DESC LIMIT 1;
      IF v_id IS NULL THEN
        INSERT INTO cekirdek.bolum (kod, ad) VALUES (v_metin, v_metin) RETURNING id INTO v_id;
      END IF;
      NEW.bolum_id := v_id;
    END IF;
    NEW.ozellik := NEW.ozellik - 'bolum';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION cekirdek.is_merkezi_bolum_metni() SET search_path = '';
CREATE TRIGGER a_bolum_metni BEFORE INSERT OR UPDATE ON cekirdek.is_merkezi
FOR EACH ROW EXECUTE FUNCTION cekirdek.is_merkezi_bolum_metni();

-- Mevcut kurulumlar: metin bolumleri karta cevir (trigger isi yapar).
UPDATE cekirdek.is_merkezi SET ozellik = ozellik WHERE ozellik ? 'bolum';

-- Katalog
UPDATE sistem.alan_tanim SET gorunur = false,
  aciklama = 'Eski serbest metin (0046). Yazılırsa bölüm kartına çevrilir; Bölüm (bolum_id) kullanın.'
WHERE varlik = 'cekirdek.is_merkezi' AND alan_kodu = 'bolum';

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu, aciklama) VALUES
  ('cekirdek.bolum', 'kod', 'Kod', '{"en":"Code"}', 'Kimlik', 10, 'metin', NULL, 'kolon', true, true, true, NULL),
  ('cekirdek.bolum', 'ad', 'Ad', '{"en":"Name"}', 'Kimlik', 20, 'metin', NULL, 'kolon', true, true, true, NULL),
  ('cekirdek.bolum', 'aktif', 'Aktif', '{"en":"Active"}', 'Kimlik', 90, 'evet_hayir', NULL, 'kolon', true, true, false, NULL),
  ('cekirdek.is_merkezi', 'bolum_id', 'Bölüm', '{"en":"Department"}', 'Kimlik', 31, 'iliski', 'cekirdek.bolum', 'kolon', false, true, false,
   'İstasyonun bulunduğu bölüm. Bölümde istasyon seçilmemiş operatör bölümün tüm istasyonlarında çalışabilir.');

-- Gorunumler
CREATE VIEW cekirdek.kaynak_calisabilir_istasyon_v WITH (security_invoker = true) AS
WITH secim AS (
  SELECT x.kaynak_id, x.is_merkezi_id FROM cekirdek.kaynak_is_merkezi x
  UNION
  SELECT k.id, k.is_merkezi_id FROM cekirdek.kaynak k WHERE k.is_merkezi_id IS NOT NULL
), secim_bolum AS (
  SELECT s.kaynak_id, s.is_merkezi_id, im.bolum_id FROM secim s JOIN cekirdek.is_merkezi im ON im.id = s.is_merkezi_id
)
SELECT s.kaynak_id, s.is_merkezi_id, 'istasyon'::text AS neden
FROM secim_bolum s JOIN cekirdek.is_merkezi im ON im.id = s.is_merkezi_id AND im.aktif
UNION ALL
SELECT kb.kaynak_id, im.id, 'bolum'
FROM cekirdek.kaynak_bolum kb
JOIN cekirdek.is_merkezi im ON im.bolum_id = kb.bolum_id AND im.aktif
WHERE NOT EXISTS (SELECT 1 FROM secim_bolum s WHERE s.kaynak_id = kb.kaynak_id AND s.bolum_id = kb.bolum_id)
UNION ALL
SELECT k.id, im.id, 'tum'
FROM cekirdek.kaynak k JOIN cekirdek.is_merkezi im ON im.aktif
WHERE NOT EXISTS (SELECT 1 FROM cekirdek.kaynak_bolum kb WHERE kb.kaynak_id = k.id)
  AND NOT EXISTS (SELECT 1 FROM secim s WHERE s.kaynak_id = k.id);
COMMENT ON VIEW cekirdek.kaynak_calisabilir_istasyon_v IS
  'Kaynagin calisabilecegi aktif istasyonlar (0046 kurali). neden: istasyon | bolum | tum.';

CREATE VIEW cekirdek.operasyon_yapilabilir_istasyon_v WITH (security_invoker = true) AS
SELECT x.operasyon_id, x.is_merkezi_id, 'istasyon'::text AS neden
FROM cekirdek.operasyon_is_merkezi x JOIN cekirdek.is_merkezi im ON im.id = x.is_merkezi_id AND im.aktif
UNION ALL
SELECT bo.operasyon_id, im.id, 'bolum'
FROM cekirdek.bolum_operasyon bo JOIN cekirdek.is_merkezi im ON im.bolum_id = bo.bolum_id AND im.aktif
WHERE NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_is_merkezi x WHERE x.operasyon_id = bo.operasyon_id)
UNION ALL
SELECT o.id, im.id, 'varsayilan'
FROM cekirdek.operasyon o JOIN cekirdek.is_merkezi im ON im.id = o.varsayilan_is_merkezi_id AND im.aktif
WHERE NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_is_merkezi x WHERE x.operasyon_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM cekirdek.bolum_operasyon bo WHERE bo.operasyon_id = o.id)
UNION ALL
SELECT o.id, im.id, 'tum'
FROM cekirdek.operasyon o JOIN cekirdek.is_merkezi im ON im.aktif
WHERE o.varsayilan_is_merkezi_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_is_merkezi x WHERE x.operasyon_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM cekirdek.bolum_operasyon bo WHERE bo.operasyon_id = o.id);
COMMENT ON VIEW cekirdek.operasyon_yapilabilir_istasyon_v IS
  'Operasyonun yapilabildigi aktif istasyonlar (0046 kurali). neden: istasyon | bolum | varsayilan | tum.';

GRANT SELECT ON cekirdek.kaynak_calisabilir_istasyon_v, cekirdek.operasyon_yapilabilir_istasyon_v TO authenticated;
`,ei=`-- 0047 · GECICI SIFRE -> ILK GIRISTE SIFRE BELIRLEME
--
-- Toplu operator hesabi (uretim kullanici.operatorHesaplariAc) ve yoneticinin "sifreyi sifirla"si GECICI sifre verir:
-- yonetici bilir, kagitta/Excel'de dolasir. Kullanici kendi sifresini belirlemeden calismamali.
--
--   sistem.kullanici.sifre_degismeli : true iken sunucu islem kapisi (veri/islem.ts) yalniz kendi kaydini okumaya
--   ve sifre belirlemeye izin verir; diger her islem "once sifrenizi belirleyin" ile reddedilir. Bayrak istemcide
--   degil burada durur: tarayicidan atlatilamaz. Sifre sunucuda (Auth yonetim API'si) degisir, bayrak ayni istekte iner.

SELECT sistem.baglam_kur('kurulum', NULL, '0047_kullanici_sifre_degismeli', 'gecici sifre bayragi');

ALTER TABLE sistem.kullanici ADD COLUMN sifre_degismeli boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN sistem.kullanici.sifre_degismeli IS
  'Gecici sifre verildi (toplu hesap ya da yonetici sifirlamasi): kullanici kendi sifresini belirleyene kadar yalniz sifre belirleme cagrilabilir.';
`,ni=`-- 0048 · OPERASYON FASON TARIFESI (adet ya da kg) + RECETEDEN KALEM AGIRLIGI
--
-- Fason fiyati yalniz rota adiminda, ADET basina tutuluyordu (0020). Galvaniz, boya, isil islem gibi fasonlar
-- firmada KG ile fiyatlanir ve yuzlerce kalemde ayni tarifedir: her rota adimina elle adet fiyati yazmak hem
-- yapilamaz hem yanlis olur. Ozler pilotu (17 Eyl): 244 kalemde galvaniz adimi fiyatsiz, maliyet bos.
--
--   operasyon.fason_birim_fiyat  : operasyonun varsayilan fason fiyati (firma para birimi).
--   operasyon.fason_fiyat_birimi : 'adet' | 'kg'. kg ise kalem basina fiyat = tarife × kalemin agirligi.
--   Oncelik: rota adimindaki fiyat (0020, kaleme ozel pazarlik) > operasyon tarifesi.
--
--   cekirdek.kalem_agirlik_kg(kalem) : 1 stok birimi kalemin kg agirligi.
--     * kalemin ozellik.birim_agirlik'i (kg / stok birimi) doluysa o;
--     * yoksa aktif GENEL agacindan: her bilesen satiri icin
--         satir birimi kutle boyutundaysa miktar dogrudan kg'a cevrilir,
--         degilse bilesenin agirligi (ozyinelemeli) × miktar (satir birimi stok birimine cevrilir; boyut farkliysa bilinmez);
--       HAMMADDE ya da agaci olan bilesenin agirligi bilinmiyorsa sonuc BILINMEZ (NULL: sessiz eksik agirlik yok);
--       sarf/aksesuar gibi agacsiz ve agirliksiz bilesen sayilmaz (vida, etiket).
--     * satir firesi sayilmaz: fasoncu bitmis parcayi tartar.
--   Ornek: boru (stok birimi m) birim_agirlik = kg/m; parca 1,2 m boru -> 1,2 × kg/m.
--
-- Dedektor D-FASON-FIYAT-YOK: adimda da operasyonda da fiyat yoksa; kg tarifesi var ama agirlik bilinmiyorsa
-- ayri mesajla ("agirlik bilinmiyor") yine bulgu — maliyet ikisinde de bostur.

SELECT sistem.baglam_kur('kurulum', NULL, '0048_fason_tarifesi_agirlik', 'fason tarifesi ve kalem agirligi');

ALTER TABLE cekirdek.operasyon
  ADD COLUMN fason_birim_fiyat numeric CHECK (fason_birim_fiyat IS NULL OR fason_birim_fiyat >= 0),
  ADD COLUMN fason_fiyat_birimi text NOT NULL DEFAULT 'adet' CHECK (fason_fiyat_birimi IN ('adet','kg'));
COMMENT ON COLUMN cekirdek.operasyon.fason_birim_fiyat IS
  'Dis tedarik operasyonunun varsayilan fiyati (firma para birimi). Rota adiminda fiyat varsa o kullanilir.';
COMMENT ON COLUMN cekirdek.operasyon.fason_fiyat_birimi IS
  'adet: kalem basina fiyat; kg: fiyat × kalem agirligi (cekirdek.kalem_agirlik_kg).';

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu, aciklama) VALUES
  ('cekirdek.operasyon', 'fason_birim_fiyat', 'Fason fiyat', '{"en":"Subcontract price"}', 'Maliyet', 10, 'para', NULL, 'kolon', false, true, false,
   'Dış tedarik operasyonunun varsayılan fiyatı. Rota adımında fiyat yazılıysa o geçerlidir.'),
  ('cekirdek.operasyon', 'fason_fiyat_birimi', 'Fason fiyat birimi', '{"en":"Subcontract price unit"}', 'Maliyet', 20, 'metin', NULL, 'kolon', false, true, false,
   'adet ya da kg. kg ise kalem fiyatı = fiyat × kalemin ağırlığı (birim ağırlık ya da reçeteden).');

CREATE OR REPLACE FUNCTION cekirdek.kalem_agirlik_kg(p_kalem uuid, p_derinlik int DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_ozellik numeric;
  v_agac uuid;
  v_toplam numeric := 0;
  v_parca numeric;
  s record;
BEGIN
  IF p_derinlik > 30 THEN RETURN NULL; END IF;                       -- dongu korumasi (dongu denetimi aktarimda)
  SELECT CASE WHEN jsonb_typeof(k.ozellik -> 'birim_agirlik') = 'number' AND (k.ozellik ->> 'birim_agirlik')::numeric > 0
              THEN (k.ozellik ->> 'birim_agirlik')::numeric END
    INTO v_ozellik FROM cekirdek.kalem k WHERE k.id = p_kalem;
  IF v_ozellik IS NOT NULL THEN RETURN v_ozellik; END IF;

  SELECT a.id INTO v_agac FROM cekirdek.urun_agaci a WHERE a.kalem_id = p_kalem AND a.durum = 'aktif' AND a.baglam_kalem_id IS NULL;
  IF v_agac IS NULL THEN RETURN NULL; END IF;

  FOR s IN
    SELECT st.miktar, sb.boyut AS satir_boyut, sb.temel_carpan AS satir_carpan,
           kb.boyut AS stok_boyut, kb.temel_carpan AS stok_carpan, b.id AS bilesen, b.tip,
           EXISTS (SELECT 1 FROM cekirdek.urun_agaci x WHERE x.kalem_id = b.id AND x.durum = 'aktif') AS agacli
    FROM cekirdek.urun_agaci_satir st
    JOIN cekirdek.kalem b ON b.id = st.bilesen_kalem_id
    LEFT JOIN cekirdek.birim sb ON sb.kod = st.birim
    LEFT JOIN cekirdek.birim kb ON kb.kod = b.stok_birimi
    WHERE st.agac_id = v_agac
  LOOP
    IF s.satir_boyut = 'kutle' THEN
      v_toplam := v_toplam + s.miktar * s.satir_carpan;
      CONTINUE;
    END IF;
    v_parca := cekirdek.kalem_agirlik_kg(s.bilesen, p_derinlik + 1);
    IF v_parca IS NULL THEN
      IF s.tip = 'hammadde' OR s.agacli THEN RETURN NULL; END IF;     -- bilinmesi gereken agirlik yok
      CONTINUE;                                                      -- agirliksiz sarf/aksesuar sayilmaz
    END IF;
    IF s.satir_boyut IS NULL OR s.stok_boyut IS NULL OR s.satir_boyut <> s.stok_boyut THEN RETURN NULL; END IF;
    v_toplam := v_toplam + s.miktar * s.satir_carpan / s.stok_carpan * v_parca;
  END LOOP;
  RETURN v_toplam;
END $$;
ALTER FUNCTION cekirdek.kalem_agirlik_kg(uuid, int) SET search_path = '';
COMMENT ON FUNCTION cekirdek.kalem_agirlik_kg(uuid, int) IS
  '1 stok birimi kalemin kg agirligi: birim_agirlik ya da genel agactan. Bilinmezse NULL (0048).';

-- Rota adiminin etkin fason fiyati (adet basina) — maliyet ve dedektor AYNI gorunumu kullanir. Gorunum (fonksiyon
-- degil): planlayici tek sorguda cozer; agirlik fonksiyonu yalniz kg tarifesi gereken adimda cagrilir.
CREATE VIEW cekirdek.fason_fiyat_v WITH (security_invoker = true) AS
SELECT x.rota_adim_id, x.kalem_id,
       CASE WHEN x.adim_fiyati IS NOT NULL THEN x.adim_fiyati
            WHEN x.tarife IS NULL THEN NULL
            WHEN x.tarife_birimi = 'adet' THEN x.tarife
            ELSE x.tarife * x.agirlik_kg END AS fiyat,
       CASE WHEN x.adim_fiyati IS NOT NULL THEN 'adim'
            WHEN x.tarife IS NULL THEN 'yok'
            WHEN x.tarife_birimi = 'adet' THEN 'operasyon'
            WHEN x.agirlik_kg IS NULL THEN 'agirlik_yok'
            ELSE 'operasyon_kg' END AS kaynak,
       x.tarife, x.tarife_birimi, x.agirlik_kg
FROM (
  -- Agirlik fonksiyonu CASE icinde: yalniz kg tarifesi gereken adimda cagrilir (LATERAL + WHERE her satirda cagiriyordu).
  SELECT a.id AS rota_adim_id, r.kalem_id, a.dis_tedarik_birim_fiyat AS adim_fiyati,
         o.fason_birim_fiyat AS tarife, o.fason_fiyat_birimi AS tarife_birimi,
         CASE WHEN a.dis_tedarik_birim_fiyat IS NULL AND o.fason_fiyat_birimi = 'kg' AND o.fason_birim_fiyat IS NOT NULL
              THEN cekirdek.kalem_agirlik_kg(r.kalem_id) END AS agirlik_kg
  FROM cekirdek.rota_adim a
  JOIN cekirdek.rota r ON r.id = a.rota_id
  JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol = 'dis_tedarik'
  OFFSET 0                                                         -- alt sorgu acilmasin: CASE her dis referansta tekrar hesaplanmaz
) x;
COMMENT ON VIEW cekirdek.fason_fiyat_v IS
  'Fason rota adiminin etkin adet fiyati: adim > operasyon tarifesi (adet | kg × kalem agirligi). kaynak: adim|operasyon|operasyon_kg|agirlik_yok|yok (0048).';
GRANT SELECT ON cekirdek.fason_fiyat_v TO authenticated;

UPDATE sistem.dedektor SET
  aciklama = 'Rotada dış tedarik (fason) adımı var ama fiyatı çıkmıyor: ne adımda fiyat var ne operasyonda tarife, ya da tarife kg ile ama kalemin ağırlığı bilinmiyor. Kalemin maliyeti boş kalır: fason bedeli sıfır sayılmaz.',
  cozum = 'Operasyon kartına fason fiyatını (adet ya da kg) girin; kg ise kaleme birim ağırlık ya da reçetedeki hammaddelere birim ağırlık (kg/stok birimi) girin. Kaleme özel fiyat rota adımına yazılır.',
  sorgu = $q$SELECT r.kalem_id::text AS kayit_id,
          string_agg(format('%s. %s %s', a.sira, o.kod, CASE f.kaynak WHEN 'agirlik_yok' THEN 'kg tarifesi var, ağırlık bilinmiyor' ELSE 'fason fiyatı yok' END), ' · ' ORDER BY a.sira) AS mesaj,
          jsonb_build_object('adimlar', jsonb_agg(a.id ORDER BY a.sira)) AS ayrinti
   FROM cekirdek.rota_adim a
   JOIN cekirdek.rota r ON r.id = a.rota_id AND r.durum = 'aktif'
   JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol = 'dis_tedarik'
   JOIN cekirdek.fason_fiyat_v f ON f.rota_adim_id = a.id
   WHERE ($1::text[] IS NULL OR r.kalem_id::text = ANY ($1))
     AND f.fiyat IS NULL
   GROUP BY r.kalem_id$q$,
  bagimlilik = $b$[
   {"tablo":"cekirdek.rota","kayit":"kalem_id"},
   {"tablo":"cekirdek.rota_adim","sorgu":"SELECT kalem_id::text FROM cekirdek.rota WHERE id = ($1->>'rota_id')::uuid"},
   {"tablo":"cekirdek.operasyon","sorgu":"SELECT r.kalem_id::text FROM cekirdek.rota_adim a JOIN cekirdek.rota r ON r.id = a.rota_id WHERE a.operasyon_id = ($1->>'id')::uuid"},
   {"tablo":"cekirdek.kalem","kayit":"id"},
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT a.kalem_id::text FROM cekirdek.urun_agaci a WHERE a.id = ($1->>'agac_id')::uuid"}
  ]$b$
WHERE kod = 'D-FASON-FIYAT-YOK';
`,ri=`-- 0049 · BOLUM SAAT MALIYETI VE GENEL GIDERI (istasyonda bossa bolumden)
--
-- Saat maliyeti ve genel gider istasyon (is merkezi) basina tutuluyordu (0005, 0025). Firmada bu oranlar cogu zaman
-- BOLUM icin bilinir: "pres bolumunun saati 1.200 TL". Ozler pilotu (17 Eyl): 136 istasyonun hicbirinde saat maliyeti
-- yok, 15 bolum var — 136 hucreyi tek tek doldurmak pratik degil, ayni bolumde farkli deger de cogu zaman yok.
--
--   bolum.saat_maliyeti, bolum.genel_gider_saat : bolumun varsayilani.
--   cekirdek.is_merkezi_maliyet_v : istasyonun ETKIN orani ve nereden geldigi —
--       saat_maliyeti   = istasyon > bolum (kaynak: 'istasyon' | 'bolum' | NULL)
--       genel_gider_saat = istasyon > bolum
--   Istasyonda deger varsa her zaman o gecerlidir (bolumde ozel makine: lazer, robot).
--   Kaynak (operator/makine) saat maliyeti operasyon kaydinda yine hepsinden once gelir (0022).
-- Maliyet (rota plani) ve operasyon kaydi gorunumu bu gorunumden okur: iki yerde ayri kural yok.

SELECT sistem.baglam_kur('kurulum', NULL, '0049_bolum_saat_maliyeti', 'bolum saat maliyeti ve genel gider');

ALTER TABLE cekirdek.bolum
  ADD COLUMN saat_maliyeti numeric CHECK (saat_maliyeti IS NULL OR saat_maliyeti >= 0),
  ADD COLUMN genel_gider_saat numeric CHECK (genel_gider_saat IS NULL OR genel_gider_saat >= 0);
COMMENT ON COLUMN cekirdek.bolum.saat_maliyeti IS 'Bolum istasyonlarinin varsayilan saat maliyeti; istasyonda deger varsa o gecerli.';
COMMENT ON COLUMN cekirdek.bolum.genel_gider_saat IS 'Bolum istasyonlarinin varsayilan saat basina genel gideri; istasyonda deger varsa o gecerli.';

INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, iliski_varlik, depolama, sistem_alani, gorunur, zorunlu, aciklama) VALUES
  ('cekirdek.bolum', 'saat_maliyeti', 'Saat maliyeti', '{"en":"Hourly cost"}', 'Maliyet', 10, 'para', NULL, 'kolon', false, true, false,
   'Bölümdeki istasyonların varsayılanı. İstasyona ayrı değer yazılırsa o geçerlidir.'),
  ('cekirdek.bolum', 'genel_gider_saat', 'Genel gider (saat)', '{"en":"Overhead per hour"}', 'Maliyet', 20, 'para', NULL, 'kolon', false, true, false,
   'Bölümdeki istasyonların varsayılan saat başı genel gideri. İstasyona ayrı değer yazılırsa o geçerlidir.');

CREATE VIEW cekirdek.is_merkezi_maliyet_v WITH (security_invoker = true) AS
SELECT im.id AS is_merkezi_id,
       COALESCE(im.saat_maliyeti, b.saat_maliyeti) AS saat_maliyeti,
       CASE WHEN im.saat_maliyeti IS NOT NULL THEN 'istasyon' WHEN b.saat_maliyeti IS NOT NULL THEN 'bolum' END AS saat_maliyeti_kaynagi,
       COALESCE(im.genel_gider_saat, b.genel_gider_saat) AS genel_gider_saat,
       CASE WHEN im.genel_gider_saat IS NOT NULL THEN 'istasyon' WHEN b.genel_gider_saat IS NOT NULL THEN 'bolum' END AS genel_gider_kaynagi,
       b.kod AS bolum_kod
FROM cekirdek.is_merkezi im
LEFT JOIN cekirdek.bolum b ON b.id = im.bolum_id;
COMMENT ON VIEW cekirdek.is_merkezi_maliyet_v IS 'Istasyonun etkin saat maliyeti ve genel gideri: istasyon > bolum (0049).';
GRANT SELECT ON cekirdek.is_merkezi_maliyet_v TO authenticated;

-- Operasyon kaydi: kolonlar ayni, oranlar etkin gorunumden.
CREATE OR REPLACE VIEW cekirdek.operasyon_kaydi_v AS
SELECT ok.id, ok.belge_satir_id, b.no AS belge_no, s.kalem_id, k.kod AS kalem_kod, k.stok_birimi,
       ok.rota_adim_id, ra.sira AS adim_sira, o.id AS operasyon_id, o.kod AS operasyon_kod, o.ad AS operasyon_ad, o.rol AS operasyon_rolu,
       im.id AS is_merkezi_id, im.kod AS is_merkezi_kod, ok.kaynak_id, kn.kod AS kaynak_kod, kn.ad AS kaynak_ad,
       ok.tur, ok.baslangic, ok.bitis, ok.iptal, ok.miktar, ok.fire_miktar, ok.aciklama,
       CASE WHEN ok.iptal THEN NULL
            ELSE COALESCE(ok.sure_dk, EXTRACT(EPOCH FROM (ok.bitis - ok.baslangic)) / 60.0) END AS etkin_sure_dk,
       COALESCE(kn.saat_maliyeti, imm.saat_maliyeti) AS saat_maliyeti,
       imm.genel_gider_saat
FROM cekirdek.operasyon_kaydi ok
JOIN cekirdek.belge_satir s ON s.id = ok.belge_satir_id
JOIN cekirdek.belge b ON b.id = s.belge_id
JOIN cekirdek.kalem k ON k.id = s.kalem_id
JOIN cekirdek.operasyon o ON o.id = ok.operasyon_id
LEFT JOIN cekirdek.rota_adim ra ON ra.id = ok.rota_adim_id
LEFT JOIN cekirdek.is_merkezi im ON im.id = COALESCE(ok.is_merkezi_id, ra.is_merkezi_id, o.varsayilan_is_merkezi_id)
LEFT JOIN cekirdek.is_merkezi_maliyet_v imm ON imm.is_merkezi_id = im.id
LEFT JOIN cekirdek.kaynak kn ON kn.id = ok.kaynak_id;

-- Dedektor: genel gider var, saat maliyeti yok — etkin degerlerle (bolumden gelen de sayilir).
UPDATE sistem.dedektor SET
  sorgu = $q$SELECT m.id::text AS kayit_id,
          format('%s: genel gider %s/saat girilmiş ama saat maliyeti yok (istasyonda da bölümde de)', m.kod, v.genel_gider_saat) AS mesaj,
          jsonb_build_object('genel_gider_saat', v.genel_gider_saat, 'genel_gider_kaynagi', v.genel_gider_kaynagi) AS ayrinti
   FROM cekirdek.is_merkezi m
   JOIN cekirdek.is_merkezi_maliyet_v v ON v.is_merkezi_id = m.id
   WHERE ($1::text[] IS NULL OR m.id::text = ANY ($1))
     AND m.aktif AND v.genel_gider_saat IS NOT NULL AND v.genel_gider_saat > 0 AND v.saat_maliyeti IS NULL$q$,
  bagimlilik = $b$[
   {"tablo":"cekirdek.is_merkezi","kayit":"id"},
   {"tablo":"cekirdek.bolum","sorgu":"SELECT id::text FROM cekirdek.is_merkezi WHERE bolum_id = ($1->>'id')::uuid"}
  ]$b$,
  cozum = 'İstasyona ya da bölümüne saat maliyetini girin, ya da genel gider oranını kaldırın.'
WHERE kod = 'D-IM-GENEL-GIDER-YALNIZ';
`,ki=`-- 0050 · KAPANMIS SAHA KAYDINDA "GERI AL" (operasyon_kaydi, durus_kaydi)
--
-- Hata (17 Eyl canli uctan uca deneme): Bitir'den sonra bildirimdeki "Geri al" calismiyordu —
-- "Kapanmis operasyon/durus kaydi degistirilemez". Kapi (0022, 0037) kapanmis kaydin her UPDATE'ini
-- reddediyordu; sistem.islem_geri_al'in kapanisi geri yazan UPDATE'i de buna takiliyordu. Operator yanlis
-- Bitir'e basip geri almak istediginde hata goruyordu.
--
-- Duzeltme: kaynak = 'geri_al' baglaminda UPDATE serbest (silme zaten serbestti). Ekrandan/sunucudan gelen
-- degisiklik icin defter kurali aynen gecerli. Fonksiyon govdeleri 0022/0037 ile ayni, yalniz bu giris eklendi.

SELECT sistem.baglam_kur('kurulum', NULL, '0050_saha_kaydi_geri_al', 'kapanmis saha kaydinda geri al');

CREATE OR REPLACE FUNCTION cekirdek.operasyon_kaydi_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tur  text;
  v_rol  text;
  v_rota uuid;
BEGIN
  -- 0050: islem geri alma (sistem.islem_geri_al) kapanmis kaydin kapanisini da geri yazar; defter kurali ekrandan
  -- gelen degisiklik icindir, geri alma olay defterinin kendi ters kaydidir.
  IF TG_OP = 'UPDATE' AND COALESCE(sistem.baglam('kaynak'), '') = 'geri_al' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(sistem.baglam('kaynak'), '') <> 'geri_al' THEN
      RAISE EXCEPTION 'Operasyon kaydi silinemez. Duzeltme icin kaydi iptal edip yenisini girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Kapanmis kayit yalniz IPTAL edilebilir (ve iptal gerekcesi yazilabilir).
    IF (OLD.bitis IS NOT NULL OR OLD.sure_dk IS NOT NULL)
       AND (to_jsonb(NEW) - 'iptal' - 'aciklama' - 'guncelleme') IS DISTINCT FROM (to_jsonb(OLD) - 'iptal' - 'aciklama' - 'guncelleme') THEN
      RAISE EXCEPTION 'Kapanmis operasyon kaydi degistirilemez; iptal edip yeni kayit girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.iptal AND NOT NEW.iptal THEN
      RAISE EXCEPTION 'Iptal edilmis operasyon kaydi geri acilamaz; yeni kayit girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.iptal AND NULLIF(btrim(COALESCE(NEW.aciklama, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Operasyon kaydi aciklamasiz iptal edilemez.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT b.tur INTO v_tur FROM cekirdek.belge_satir s JOIN cekirdek.belge b ON b.id = s.belge_id WHERE s.id = NEW.belge_satir_id;
  IF v_tur <> 'uretim_emri' THEN
    RAISE EXCEPTION 'Operasyon kaydi yalniz uretim emri satirina girilir (belge turu: %).', v_tur USING ERRCODE = 'check_violation';
  END IF;

  SELECT rol INTO v_rol FROM cekirdek.operasyon WHERE id = NEW.operasyon_id;
  IF v_rol = 'dis_tedarik' THEN
    RAISE EXCEPTION 'Dis tedarik (fason) adimina sure kaydi girilmez: suresi tedarikcinin gunudur, maliyeti adet basina fiyattir.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.rota_adim_id IS NOT NULL THEN
    SELECT rota_id INTO v_rota FROM cekirdek.rota_adim WHERE id = NEW.rota_adim_id;
    IF NOT EXISTS (SELECT 1 FROM cekirdek.rota r JOIN cekirdek.belge_satir s ON s.id = NEW.belge_satir_id
                   WHERE r.id = v_rota AND r.kalem_id = s.kalem_id) THEN
      RAISE EXCEPTION 'Rota adimi bu emrin kalemine ait degil.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;
ALTER FUNCTION cekirdek.operasyon_kaydi_kapisi() SET search_path = '';

CREATE OR REPLACE FUNCTION cekirdek.durus_kaydi_kapisi()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tur text;
BEGIN
  -- 0050: islem geri alma (sistem.islem_geri_al) kapanmis kaydin kapanisini da geri yazar; defter kurali ekrandan
  -- gelen degisiklik icindir, geri alma olay defterinin kendi ters kaydidir.
  IF TG_OP = 'UPDATE' AND COALESCE(sistem.baglam('kaynak'), '') = 'geri_al' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(sistem.baglam('kaynak'), '') <> 'geri_al' THEN
      RAISE EXCEPTION 'Durus kaydi silinemez. Duzeltme icin kaydi iptal edip yenisini girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (OLD.bitis IS NOT NULL OR OLD.sure_dk IS NOT NULL)
       AND (to_jsonb(NEW) - 'iptal' - 'aciklama' - 'guncelleme') IS DISTINCT FROM (to_jsonb(OLD) - 'iptal' - 'aciklama' - 'guncelleme') THEN
      RAISE EXCEPTION 'Kapanmis durus kaydi degistirilemez; iptal edip yeni kayit girin.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.iptal AND NOT NEW.iptal THEN
      RAISE EXCEPTION 'Iptal edilmis durus kaydi geri acilamaz; yeni kayit girin.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.iptal AND NULLIF(btrim(COALESCE(NEW.aciklama, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Durus kaydi aciklamasiz iptal edilemez.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM cekirdek.durus_nedeni WHERE id = NEW.neden_id AND aktif) THEN
    RAISE EXCEPTION 'Durus nedeni aktif degil.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.belge_satir_id IS NOT NULL THEN
    SELECT b.tur INTO v_tur FROM cekirdek.belge_satir s JOIN cekirdek.belge b ON b.id = s.belge_id WHERE s.id = NEW.belge_satir_id;
    IF v_tur <> 'uretim_emri' THEN
      RAISE EXCEPTION 'Durus yalniz uretim emri satirina baglanir (belge turu: %).', v_tur USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION cekirdek.durus_kaydi_kapisi() SET search_path = '';
`,li=`-- 0051 · VARSAYIM GORUNURLUGU — tahmini girilmis degerler defterden bulunur, gercek deger girilince kendiliginden duser.
--
-- Pilot kurulumda bilinmeyen degerler "varsayimla ilerle" karariyla tahmini girilir (standart maliyet, saat maliyeti,
-- istasyon kapasitesi, rota ...). Bunlar gercek veriden AYIRT EDILMEZSE hesaplar gercek sanilir.
--
-- Kural (veri degil gerekce): bir alanin olay defterindeki SON degisikliginin gerekcesi "TAHMIN" ya da "VARSAYIM" ile
-- basliyorsa (buyuk/kucuk harf farketmez) o deger varsayimdir. Yeni tablo, bayrak kolonu, kopyalanan veri YOK:
--   * gercek deger girilince son degisiklik artik tahmini degildir -> listeden duser;
--   * geri alma da defterde yeni olaydir -> ayni kural.
--
-- sistem.varsayim_v satirlari:
--   * alan duzeyi: 'degistir' olaylari; ozellik jsonb'si ANAHTAR anahtar acilir (alan = 'standart_maliyet', 'ozellik' degil),
--     boylece hesap izindeki kaynak.alan ile birebir eslesir.
--   * kayit duzeyi (alan = '*'): kayit tahmini EKLENDIYSE ve sonrasinda tahmini olmayan hicbir degisiklik yoksa.
--   * silinmis kayit listelenmez.

SELECT sistem.baglam_kur('kurulum', NULL, '0051_varsayim_gorunurlugu', 'varsayim gorunurlugu');

CREATE OR REPLACE FUNCTION sistem.varsayim_gerekcesi_mi(p_gerekce text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_gerekce ~* '^\\s*(tahm[iİı]n|varsay)', false)   -- Turkce I: TAHMİNİ de
$$;
ALTER FUNCTION sistem.varsayim_gerekcesi_mi(text) SET search_path = '';
COMMENT ON FUNCTION sistem.varsayim_gerekcesi_mi(text) IS
  'Islem grubu gerekcesi TAHMIN.../VARSAYIM... ile basliyorsa o islemin yazdigi degerler varsayimdir (sistem.varsayim_v).';

CREATE INDEX olay_varsayim_idx ON sistem.olay (varlik, kayit_id) WHERE sistem.varsayim_gerekcesi_mi(gerekce);

CREATE VIEW sistem.varsayim_v WITH (security_invoker = true) AS
WITH aday AS (
  SELECT DISTINCT varlik, kayit_id FROM sistem.olay WHERE sistem.varsayim_gerekcesi_mi(gerekce)
), olaylar AS (
  SELECT o.id, o.zaman, o.kullanici, o.gerekce, o.islem_grubu, o.varlik, o.kayit_id, o.islem, k.alan, k.deger
  FROM sistem.olay o
  JOIN aday a ON a.varlik = o.varlik AND a.kayit_id = o.kayit_id
  CROSS JOIN LATERAL (
    SELECT '*'::text AS alan, NULL::jsonb AS deger WHERE o.islem IN ('ekle', 'sil')
    UNION ALL
    SELECT o.alan, o.yeni WHERE o.islem = 'degistir' AND o.alan <> 'ozellik'
    UNION ALL
    SELECT e.key, e.value FROM jsonb_each(CASE WHEN jsonb_typeof(o.yeni) = 'object' THEN o.yeni ELSE '{}'::jsonb END) e
    WHERE o.islem = 'degistir' AND o.alan = 'ozellik' AND e.value IS DISTINCT FROM o.eski -> e.key
    UNION ALL
    SELECT e.key, NULL FROM jsonb_each(CASE WHEN jsonb_typeof(o.eski) = 'object' THEN o.eski ELSE '{}'::jsonb END) e
    WHERE o.islem = 'degistir' AND o.alan = 'ozellik' AND NOT (COALESCE(o.yeni, '{}'::jsonb) ? e.key)
  ) k
), son_kayit AS (
  SELECT DISTINCT ON (varlik, kayit_id) varlik, kayit_id, islem FROM olaylar ORDER BY varlik, kayit_id, id DESC
), son_alan AS (
  SELECT DISTINCT ON (varlik, kayit_id, alan) * FROM olaylar WHERE alan <> '*' ORDER BY varlik, kayit_id, alan, id DESC
), ekleme AS (
  SELECT DISTINCT ON (varlik, kayit_id) * FROM olaylar WHERE islem = 'ekle' ORDER BY varlik, kayit_id, id DESC
)
SELECT s.varlik, s.kayit_id, s.alan, s.deger, s.zaman, s.kullanici, s.gerekce, s.islem_grubu
FROM son_alan s JOIN son_kayit sk ON sk.varlik = s.varlik AND sk.kayit_id = s.kayit_id
WHERE sistem.varsayim_gerekcesi_mi(s.gerekce) AND sk.islem <> 'sil'
UNION ALL
SELECT e.varlik, e.kayit_id, '*', NULL, e.zaman, e.kullanici, e.gerekce, e.islem_grubu
FROM ekleme e JOIN son_kayit sk ON sk.varlik = e.varlik AND sk.kayit_id = e.kayit_id
WHERE sistem.varsayim_gerekcesi_mi(e.gerekce) AND sk.islem <> 'sil'
  AND NOT EXISTS (SELECT 1 FROM olaylar x WHERE x.varlik = e.varlik AND x.kayit_id = e.kayit_id AND x.id > e.id AND NOT sistem.varsayim_gerekcesi_mi(x.gerekce));

COMMENT ON VIEW sistem.varsayim_v IS
  'Son degisikligi TAHMIN/VARSAYIM gerekceli alanlar (alan) ve tahmini eklenip sonra dokunulmamis kayitlar (alan = *). Gercek deger girilince duser.';
GRANT SELECT ON sistem.varsayim_v TO authenticated;
`,ti=`-- 0052 · KOD SABLONU DEDEKTORU PLANLANMAZ KALEMI SAYMAZ
--
-- 0043 agacsiz uyarisinda oldugu gibi: planlanmaz isaretli kalem (eski/kullanilmayan kart, recetesi olmayan urun)
-- planlamaya, uretime, satin almaya girmez; kodunun firma sablonuna uymamasi hicbir islemi bozmaz ve gercek
-- bulguyu (kullanilan kalemin bozuk kodu) gurultu icinde kaybettirir. Ozler pilotu (17 Eyl): 181 bulgunun 154'u
-- planlanmaz eski kart. Kalem yeniden MRP'ye alininca bulgu geri gelir (kalem degisikligi dedektoru calistirir).

SELECT sistem.baglam_kur('kurulum', NULL, '0052_kod_sablonu_planlanmaz_haric', 'kod sablonu dedektoru planlanmaz haric');

DO $$
DECLARE
  v_eski text := 'WHERE ($1::text[] IS NULL OR k.id = ANY ($1::uuid[]))';
  v_yeni text := 'WHERE ($1::text[] IS NULL OR k.id = ANY ($1::uuid[])) AND k.planlama_yontemi <> ''planlanmaz''';
  v_sorgu text;
BEGIN
  SELECT sorgu INTO v_sorgu FROM sistem.dedektor WHERE kod = 'D-KALEM-KOD-SABLONU';
  IF position(v_eski IN v_sorgu) = 0 THEN
    RAISE EXCEPTION '0052: D-KALEM-KOD-SABLONU sorgusunda beklenen kosul bulunamadi.';
  END IF;
  UPDATE sistem.dedektor SET sorgu = replace(v_sorgu, v_eski, v_yeni) WHERE kod = 'D-KALEM-KOD-SABLONU';
END $$;
`,si=`-- 0053 · YABANCI ANAHTAR INDEKSLERI — her FK'nin kapsayan indeksi olur.
--
-- Postgres FK icin indeks ACMAZ. Indekssiz FK'de ust kayit silinince/anahtari degisince alt tablo bastan sona
-- taranir (stok_hareket, operasyon_kaydi, olay gibi buyuyen tablolarda her silme/geri alma yavaslar) ve
-- birlestirmeler (rota_adim -> operasyon/istasyon, operasyon_kaydi -> rota_adim) indeks kullanamaz.
-- Kaynak: Supabase performans danismani, uretim-urun 17 Eyl 2026: 38 bulgu (bu listeyle ayni).
-- Kural artik testle korunur: tests/yapi.test.js "her yabanci anahtarin kapsayan indeksi var".
-- Yalniz indeks; veri degismez.

SELECT sistem.baglam_kur('kurulum', NULL, '0053_yabanci_anahtar_indeksleri', 'yabanci anahtar indeksleri');

CREATE INDEX IF NOT EXISTS belge_kaynak_belge_id_fk ON cekirdek.belge (kaynak_belge_id);
CREATE INDEX IF NOT EXISTS belge_partner_id_fk ON cekirdek.belge (partner_id);
CREATE INDEX IF NOT EXISTS belge_satir_baglam_kalem_id_fk ON cekirdek.belge_satir (baglam_kalem_id);
CREATE INDEX IF NOT EXISTS belge_satir_birim_fk ON cekirdek.belge_satir (birim);
CREATE INDEX IF NOT EXISTS belge_satir_kaynak_satir_id_fk ON cekirdek.belge_satir (kaynak_satir_id);
CREATE INDEX IF NOT EXISTS durus_kaydi_belge_satir_id_fk ON cekirdek.durus_kaydi (belge_satir_id);
CREATE INDEX IF NOT EXISTS durus_kaydi_kaynak_id_fk ON cekirdek.durus_kaydi (kaynak_id);
CREATE INDEX IF NOT EXISTS durus_kaydi_neden_id_fk ON cekirdek.durus_kaydi (neden_id);
CREATE INDEX IF NOT EXISTS kalem_stok_birimi_fk ON cekirdek.kalem (stok_birimi);
CREATE INDEX IF NOT EXISTS kalem_varsayilan_depo_id_fk ON cekirdek.kalem (varsayilan_depo_id);
CREATE INDEX IF NOT EXISTS kalem_birim_hedef_birim_fk ON cekirdek.kalem_birim (hedef_birim);
CREATE INDEX IF NOT EXISTS kalem_birim_kaynak_birim_fk ON cekirdek.kalem_birim (kaynak_birim);
CREATE INDEX IF NOT EXISTS kalem_maliyet_baglam_kalem_id_fk ON cekirdek.kalem_maliyet (baglam_kalem_id);
CREATE INDEX IF NOT EXISTS kalite_karari_belge_satir_id_fk ON cekirdek.kalite_karari (belge_satir_id);
CREATE INDEX IF NOT EXISTS kaynak_is_merkezi_id_fk ON cekirdek.kaynak (is_merkezi_id);
CREATE INDEX IF NOT EXISTS operasyon_rol_fk ON cekirdek.operasyon (rol);
CREATE INDEX IF NOT EXISTS operasyon_varsayilan_is_merkezi_id_fk ON cekirdek.operasyon (varsayilan_is_merkezi_id);
CREATE INDEX IF NOT EXISTS operasyon_kaydi_is_merkezi_id_fk ON cekirdek.operasyon_kaydi (is_merkezi_id);
CREATE INDEX IF NOT EXISTS operasyon_kaydi_operasyon_id_fk ON cekirdek.operasyon_kaydi (operasyon_id);
CREATE INDEX IF NOT EXISTS operasyon_kaydi_rota_adim_id_fk ON cekirdek.operasyon_kaydi (rota_adim_id);
CREATE INDEX IF NOT EXISTS problem_belge_satir_id_fk ON cekirdek.problem (belge_satir_id);
CREATE INDEX IF NOT EXISTS problem_durus_kaydi_id_fk ON cekirdek.problem (durus_kaydi_id);
CREATE INDEX IF NOT EXISTS problem_is_merkezi_id_fk ON cekirdek.problem (is_merkezi_id);
CREATE INDEX IF NOT EXISTS problem_kalem_id_fk ON cekirdek.problem (kalem_id);
CREATE INDEX IF NOT EXISTS problem_kaynak_id_fk ON cekirdek.problem (kaynak_id);
CREATE INDEX IF NOT EXISTS rota_adim_is_merkezi_id_fk ON cekirdek.rota_adim (is_merkezi_id);
CREATE INDEX IF NOT EXISTS rota_adim_operasyon_id_fk ON cekirdek.rota_adim (operasyon_id);
CREATE INDEX IF NOT EXISTS sayim_satir_belge_satir_id_fk ON cekirdek.sayim_satir (belge_satir_id);
CREATE INDEX IF NOT EXISTS sayim_satir_depo_id_fk ON cekirdek.sayim_satir (depo_id);
CREATE INDEX IF NOT EXISTS sayim_satir_kalem_id_fk ON cekirdek.sayim_satir (kalem_id);
CREATE INDEX IF NOT EXISTS sayim_satir_lot_id_fk ON cekirdek.sayim_satir (lot_id);
CREATE INDEX IF NOT EXISTS stok_hareket_depo_id_fk ON cekirdek.stok_hareket (depo_id);
CREATE INDEX IF NOT EXISTS stok_hareket_lokasyon_id_fk ON cekirdek.stok_hareket (lokasyon_id);
CREATE INDEX IF NOT EXISTS stok_hareket_ters_hareket_id_fk ON cekirdek.stok_hareket (ters_hareket_id);
CREATE INDEX IF NOT EXISTS tedarik_kosulu_birim_fk ON cekirdek.tedarik_kosulu (birim);
CREATE INDEX IF NOT EXISTS urun_agaci_satir_birim_fk ON cekirdek.urun_agaci_satir (birim);
CREATE INDEX IF NOT EXISTS yetkinlik_operasyon_id_fk ON cekirdek.yetkinlik (operasyon_id);
CREATE INDEX IF NOT EXISTS dedektor_kural_kod_fk ON sistem.dedektor (kural_kod);
`,Ei=`-- 0054 · VARSAYIM GORUNUMU HIZI — sistem.varsayim_v olay defterini bastan sona taramaz.
--
-- 0051 gorunumu aday kayitlarin olaylarini JOIN ile aliyordu; planlayici aday sayisini ~6 kat fazla tahmin edip butun
-- defteri (canli: 34 bin satir, 31 MB, genis jsonb) sirayla tarayip hash join yapiyordu: 1,3 sn. Maliyet listesi ve
-- Veri kalitesi ekrani bu gorunumu her acilista okur (78 olcumu: maliyet listesi 8,95 sn).
-- Simdi aday basina indeksli erisim (LATERAL + olay_kayit_idx). Canli olcum (ayni sonuc, 1.675 satir): 1.310 ms -> 353 ms.
-- Mantik ve kolonlar degismez (CREATE OR REPLACE); tests/varsayim.test.js ayni kurallari denetler.

SELECT sistem.baglam_kur('kurulum', NULL, '0054_varsayim_gorunumu_hizi', 'varsayim gorunumu hizi');

CREATE OR REPLACE VIEW sistem.varsayim_v WITH (security_invoker = true) AS
WITH aday AS (
  SELECT DISTINCT varlik, kayit_id FROM sistem.olay WHERE sistem.varsayim_gerekcesi_mi(gerekce)
), olaylar AS (
  SELECT o.id, o.zaman, o.kullanici, o.gerekce, o.islem_grubu, o.varlik, o.kayit_id, o.islem, k.alan, k.deger
  FROM aday a
  -- OFFSET 0: planlayici alt sorguyu acmasin; aday basina olay_kayit_idx (varlik, kayit_id, id) ile erisim.
  CROSS JOIN LATERAL (SELECT * FROM sistem.olay x WHERE x.varlik = a.varlik AND x.kayit_id = a.kayit_id OFFSET 0) o
  CROSS JOIN LATERAL (
    SELECT '*'::text AS alan, NULL::jsonb AS deger WHERE o.islem IN ('ekle', 'sil')
    UNION ALL
    SELECT o.alan, o.yeni WHERE o.islem = 'degistir' AND o.alan <> 'ozellik'
    UNION ALL
    SELECT e.key, e.value FROM jsonb_each(CASE WHEN jsonb_typeof(o.yeni) = 'object' THEN o.yeni ELSE '{}'::jsonb END) e
    WHERE o.islem = 'degistir' AND o.alan = 'ozellik' AND e.value IS DISTINCT FROM o.eski -> e.key
    UNION ALL
    SELECT e.key, NULL FROM jsonb_each(CASE WHEN jsonb_typeof(o.eski) = 'object' THEN o.eski ELSE '{}'::jsonb END) e
    WHERE o.islem = 'degistir' AND o.alan = 'ozellik' AND NOT (COALESCE(o.yeni, '{}'::jsonb) ? e.key)
  ) k
), son_kayit AS (
  SELECT DISTINCT ON (varlik, kayit_id) varlik, kayit_id, islem FROM olaylar ORDER BY varlik, kayit_id, id DESC
), son_alan AS (
  SELECT DISTINCT ON (varlik, kayit_id, alan) * FROM olaylar WHERE alan <> '*' ORDER BY varlik, kayit_id, alan, id DESC
), ekleme AS (
  SELECT DISTINCT ON (varlik, kayit_id) * FROM olaylar WHERE islem = 'ekle' ORDER BY varlik, kayit_id, id DESC
)
SELECT s.varlik, s.kayit_id, s.alan, s.deger, s.zaman, s.kullanici, s.gerekce, s.islem_grubu
FROM son_alan s JOIN son_kayit sk ON sk.varlik = s.varlik AND sk.kayit_id = s.kayit_id
WHERE sistem.varsayim_gerekcesi_mi(s.gerekce) AND sk.islem <> 'sil'
UNION ALL
SELECT e.varlik, e.kayit_id, '*', NULL, e.zaman, e.kullanici, e.gerekce, e.islem_grubu
FROM ekleme e JOIN son_kayit sk ON sk.varlik = e.varlik AND sk.kayit_id = e.kayit_id
WHERE sistem.varsayim_gerekcesi_mi(e.gerekce) AND sk.islem <> 'sil'
  AND NOT EXISTS (SELECT 1 FROM olaylar x WHERE x.varlik = e.varlik AND x.kayit_id = e.kayit_id AND x.id > e.id AND NOT sistem.varsayim_gerekcesi_mi(x.gerekce));
`,di=`-- 0055 · DEDEKTOR MOTORU KUME ISARETLEME + DEGISMEYEN SATIRI ATLAMA
--
-- OLCUM (uretim-urun, 17 Eyl 2026, geri alinan islem): 500 kalemde degeri degistirmeyen UPDATE toplam 1.352 ms,
-- asil yazma 13 ms. Tetikleyiciler: zy_dedektor_isaretle 502 ms (SATIR basina: aktif dedektor listesi jsonb
-- olarak her satirda yeniden taraniyor, bagimlilik sorgusu satir basina dinamik EXECUTE), zy_dedektor_isle 420 ms,
-- b_ozellik_dogrula 204 ms, zz_olay_izle 142 ms. Hicbir deger degismedigi halde hepsi calisiyordu.
-- Bu, programin her toplu yazmasinin (aktarim, MRP belgeleme, maliyet) ortak vergisiydi.
--
-- DEGISIKLIK:
--  1. Dedektor isaretleme SATIR tetikleyicisinden IFADE tetikleyicisine (gecis tablolari; islem turu basina bir
--     tetikleyici — Postgres gecis tablosunu cok olayli tetikleyicide kabul etmez). Bagimlilik basina TEK ifade:
--       kayit  -> INSERT ... SELECT satir->>kayit FROM kume
--       sorgu  -> INSERT ... SELECT FROM kume CROSS JOIN LATERAL (<sorgu, $1 = kume satiri>)
--     Kuyruk ayni ifadenin sonunda islenir (eski zy_dedektor_isle ile ayni an): sonuc satir tetikleyicisiyle birebir.
--  2. UPDATE'te yalniz DEGISEN satirlar kumeye girer: eski/yeni kume farki, \`guncelleme\` damgasi haric
--     (a_guncelleme BEFORE tetikleyicisi damgayi her UPDATE'te yeniler).
--  3. sistem.olay_izle ve sistem.ozellik_dogrula: UPDATE'te satirin TAMAMI (guncelleme haric) degismediyse erken
--     cikis. olay_izle zaten degismeyen alana kayit yazmiyordu (sonuc ayni, baglam okumalari ve alan dongusu atlanir).
--     ozellik_dogrula: degismeyen satir icin katalog tekrar denetlenmez (veri degismiyor).
--
-- Eski sistem.dedektor_isaretle / dedektor_kuyrugu_isle fonksiyonlari silinmez (geri donus icin); tetikleyiciler
-- yeni fonksiyona baglanir. Veri degismez.

SELECT sistem.baglam_kur('kurulum', NULL, '0055_dedektor_kume_isaretleme', 'dedektor motoru kume isaretleme');

-- Islem ici kuyrugu bosaltir (eski zy_dedektor_isle govdesi, tetikleyici olmadan cagrilabilir).
CREATE OR REPLACE FUNCTION sistem.dedektor_kuyrugu_bosalt()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT dedektor_kod, array_agg(kayit_id ORDER BY kayit_id) AS kayitlar
    FROM sistem.dedektor_kuyruk WHERE islem_id = txid_current()
    GROUP BY dedektor_kod ORDER BY dedektor_kod
  LOOP
    DELETE FROM sistem.dedektor_kuyruk WHERE islem_id = txid_current() AND dedektor_kod = r.dedektor_kod;
    PERFORM sistem.dedektor_calistir(r.dedektor_kod, r.kayitlar);
  END LOOP;
END $$;

-- Ifade bitti -> degisen satir kumesinden etkilenen (dedektor, kayit) ciftlerini kuyruga yaz, kuyrugu isle.
-- Gecis tablolari: dk_yeni (INSERT, UPDATE), dk_eski (UPDATE, DELETE).
CREATE OR REPLACE FUNCTION sistem.dedektor_isaretle_kume()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, pg_temp AS $$
DECLARE
  v_tablo    text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_satirlar jsonb[];
  r          record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sistem.dedektor d, jsonb_array_elements(d.bagimlilik) b
                 WHERE d.aktif AND b ->> 'tablo' = v_tablo) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(to_jsonb(n)) INTO v_satirlar FROM dk_yeni n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(to_jsonb(o)) INTO v_satirlar FROM dk_eski o;
  ELSE
    -- Yalniz degisen satirlarin eski ve yeni hali (satir tetikleyicisi ikisini de isaretliyordu).
    SELECT array_agg(s) INTO v_satirlar FROM (
      (SELECT to_jsonb(n) - 'guncelleme' AS s FROM dk_yeni n EXCEPT SELECT to_jsonb(o) - 'guncelleme' FROM dk_eski o)
      UNION
      (SELECT to_jsonb(o) - 'guncelleme' FROM dk_eski o EXCEPT SELECT to_jsonb(n) - 'guncelleme' FROM dk_yeni n)
    ) z;
  END IF;
  IF v_satirlar IS NULL THEN
    RETURN NULL;
  END IF;

  FOR r IN
    SELECT d.kod, b AS bag FROM sistem.dedektor d, jsonb_array_elements(d.bagimlilik) b
    WHERE d.aktif AND b ->> 'tablo' = v_tablo
  LOOP
    IF r.bag ? 'kayit' THEN
      INSERT INTO sistem.dedektor_kuyruk (dedektor_kod, kayit_id)
      SELECT DISTINCT r.kod, s ->> (r.bag ->> 'kayit') FROM unnest(v_satirlar) s
      WHERE s ->> (r.bag ->> 'kayit') IS NOT NULL
      ON CONFLICT DO NOTHING;
    ELSE
      -- Bagimlilik sorgusunda $1 = degisen satir (jsonb). Kume uzerinde tek ifade. Dis takma adlar dk__ onekli:
      -- bagimlilik sorgusunun kendi takma adlariyla (s, a, x) cakismasin.
      EXECUTE format(
        'INSERT INTO sistem.dedektor_kuyruk (dedektor_kod, kayit_id)
         SELECT DISTINCT $2, dk__x.dk__v FROM unnest($1::jsonb[]) AS dk__k(dk__satir) CROSS JOIN LATERAL (%s) AS dk__x(dk__v)
         WHERE dk__x.dk__v IS NOT NULL ON CONFLICT DO NOTHING',
        replace(r.bag ->> 'sorgu', '$1', 'dk__k.dk__satir'))
      USING v_satirlar, r.kod;
    END IF;
  END LOOP;

  PERFORM sistem.dedektor_kuyrugu_bosalt();
  RETURN NULL;
END $$;

-- Bagli tabloya islem turu basina bir ifade tetikleyicisi (eski satir + ifade tetikleyicileri kaldirilir).
-- Ad sirasi: AFTER ifade tetikleyicileri ada gore calisir; zy_ oneki korunur.
CREATE OR REPLACE FUNCTION sistem.dedektor_tabloya_baglan(p_tablo regclass)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_isaretle ON %s', p_tablo);
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_isle ON %s', p_tablo);
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_ekle ON %s', p_tablo);
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_guncelle ON %s', p_tablo);
  EXECUTE format('DROP TRIGGER IF EXISTS zy_dedektor_sil ON %s', p_tablo);
  EXECUTE format('CREATE TRIGGER zy_dedektor_ekle AFTER INSERT ON %s REFERENCING NEW TABLE AS dk_yeni
                  FOR EACH STATEMENT EXECUTE FUNCTION sistem.dedektor_isaretle_kume()', p_tablo);
  EXECUTE format('CREATE TRIGGER zy_dedektor_guncelle AFTER UPDATE ON %s REFERENCING OLD TABLE AS dk_eski NEW TABLE AS dk_yeni
                  FOR EACH STATEMENT EXECUTE FUNCTION sistem.dedektor_isaretle_kume()', p_tablo);
  EXECUTE format('CREATE TRIGGER zy_dedektor_sil AFTER DELETE ON %s REFERENCING OLD TABLE AS dk_eski
                  FOR EACH STATEMENT EXECUTE FUNCTION sistem.dedektor_isaretle_kume()', p_tablo);
END $$;

-- Var olan baglari yeni tetikleyicilere tasi.
DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT DISTINCT c.oid::regclass FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
    WHERE NOT g.tgisinternal AND g.tgname IN ('zy_dedektor_isaretle', 'zy_dedektor_isle')
  LOOP
    PERFORM sistem.dedektor_tabloya_baglan(t);
  END LOOP;
END $$;

-- Olay defteri: UPDATE'te satir (guncelleme haric) degismediyse hicbir sey yazilmaz — erken cik.
CREATE OR REPLACE FUNCTION sistem.olay_izle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = sistem, cekirdek, pg_temp AS $$
DECLARE
  v_anahtar  text := COALESCE(TG_ARGV[0], 'id');
  v_varlik   text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_eski     jsonb;
  v_yeni     jsonb;
  v_kayit    text;
  v_alan     text;
  v_kaynak   text;
  v_grup     uuid;
  v_kull     text;
  v_ref      text;
  v_gerekce  text;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_eski := to_jsonb(OLD); END IF;
  IF TG_OP IN ('UPDATE','INSERT') THEN v_yeni := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND (v_yeni - 'guncelleme') = (v_eski - 'guncelleme') THEN
    RETURN NEW;
  END IF;

  v_kaynak  := COALESCE(sistem.baglam('kaynak'), 'sistem');
  v_grup    := NULLIF(sistem.baglam('islem_grubu'), '')::uuid;
  v_kull    := sistem.baglam('kullanici');
  v_ref     := sistem.baglam('kaynak_ref');
  v_gerekce := sistem.baglam('gerekce');
  v_kayit   := COALESCE(v_yeni, v_eski) ->> v_anahtar;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO sistem.olay (islem_grubu, kullanici, kaynak, kaynak_ref, gerekce, varlik, anahtar_alan, kayit_id, islem, yeni)
    VALUES (v_grup, v_kull, v_kaynak, v_ref, v_gerekce, v_varlik, v_anahtar, v_kayit, 'ekle', v_yeni);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO sistem.olay (islem_grubu, kullanici, kaynak, kaynak_ref, gerekce, varlik, anahtar_alan, kayit_id, islem, eski)
    VALUES (v_grup, v_kull, v_kaynak, v_ref, v_gerekce, v_varlik, v_anahtar, v_kayit, 'sil', v_eski);
    RETURN OLD;
  END IF;

  FOR v_alan IN SELECT jsonb_object_keys(v_yeni) LOOP
    CONTINUE WHEN sistem.olay_yok_sayilan_alan(v_alan);
    CONTINUE WHEN (v_eski -> v_alan) IS NOT DISTINCT FROM (v_yeni -> v_alan);
    INSERT INTO sistem.olay (islem_grubu, kullanici, kaynak, kaynak_ref, gerekce, varlik, anahtar_alan, kayit_id, islem, alan, eski, yeni)
    VALUES (v_grup, v_kull, v_kaynak, v_ref, v_gerekce, v_varlik, v_anahtar, v_kayit, 'degistir', v_alan, v_eski -> v_alan, v_yeni -> v_alan);
  END LOOP;
  RETURN NEW;
END $$;

-- Alan katalogu dogrulamasi: UPDATE'te satir degismediyse erken cik (govde 0004 ile ayni).
CREATE OR REPLACE FUNCTION sistem.ozellik_dogrula()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_varlik text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_kayit  jsonb := to_jsonb(NEW);
  v_oz     jsonb := COALESCE(to_jsonb(NEW) -> 'ozellik', '{}'::jsonb);
  v_anahtar text;
  t        sistem.alan_tanim;
  v_deger  jsonb;
  v_hata   text;
  v_var    boolean;
BEGIN
  -- 0055: satir (guncelleme damgasi haric) degismediyse katalog tekrar denetlenmez.
  IF TG_OP = 'UPDATE' AND (v_kayit - 'guncelleme') = (to_jsonb(OLD) - 'guncelleme') THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(v_oz) <> 'object' THEN
    RAISE EXCEPTION '%.ozellik bir nesne olmali.', v_varlik USING ERRCODE = 'check_violation';
  END IF;

  FOR v_anahtar IN SELECT jsonb_object_keys(v_oz) LOOP
    IF NOT EXISTS (SELECT 1 FROM sistem.alan_tanim a WHERE a.varlik = v_varlik AND a.alan_kodu = v_anahtar AND a.depolama = 'ozellik') THEN
      RAISE EXCEPTION '%.ozellik.%: alan katalogunda tanimli degil. Once sistem.alan_tanim''a eklenmeli.', v_varlik, v_anahtar
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  FOR t IN SELECT * FROM sistem.alan_tanim a WHERE a.varlik = v_varlik LOOP
    v_deger := CASE WHEN t.depolama = 'kolon' THEN v_kayit -> t.alan_kodu ELSE v_oz -> t.alan_kodu END;

    IF t.gorunur AND t.zorunlu AND (v_deger IS NULL OR jsonb_typeof(v_deger) = 'null'
        OR (jsonb_typeof(v_deger) = 'string' AND btrim(v_deger #>> '{}') = '')) THEN
      RAISE EXCEPTION '%: "%" zorunlu alan bos birakilamaz.', v_varlik, t.etiket USING ERRCODE = 'not_null_violation';
    END IF;

    -- Kolonlarda tipi Postgres zaten korur; burada liste/min/max ve ozellik tipleri denetlenir.
    IF t.depolama = 'ozellik' OR t.tip IN ('liste','coklu_liste') OR t.min_deger IS NOT NULL OR t.max_deger IS NOT NULL THEN
      v_hata := sistem.alan_deger_hatasi(t, v_deger);
      IF v_hata IS NOT NULL THEN
        RAISE EXCEPTION '%: "%" (%) — %; gelen deger %.', v_varlik, t.etiket, t.alan_kodu, v_hata, v_deger
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF t.tip = 'iliski' AND t.depolama = 'ozellik' AND v_deger IS NOT NULL AND jsonb_typeof(v_deger) = 'string' THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE id::text = $1)', t.iliski_varlik) INTO v_var USING v_deger #>> '{}';
      IF NOT v_var THEN
        RAISE EXCEPTION '%: "%" icin % kaydi bulunamadi: %.', v_varlik, t.etiket, t.iliski_varlik, v_deger #>> '{}'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
`,mi=`-- 0056 · KALEM AGIRLIGI KUMEDE TEK SORGU (fason_fiyat_v hizi)
--
-- 0048 cekirdek.kalem_agirlik_kg plpgsql ozyinelemesidir ve fason_fiyat_v her kg tarifeli adimda onu AYRI cagirir:
-- ayni alt agaclar tekrar tekrar gezilir. Canli olcum (f7, 17 Eyl): fason_fiyat_v 280 ms, 404 galvaniz adimi —
-- aktifRotalar okumasinin neredeyse tamami.
--
-- cekirdek.kalem_agirliklari_kg(kokler uuid[]) : ayni kural, kume uzerinde TEK WITH RECURSIVE (ustten asagi acilim):
--   * kokun ozellik.birim_agirlik'i varsa o; yoksa aktif GENEL agaci acilir (agaci yoksa bilinmez);
--   * satir birimi kutle -> miktar × carpan kg (uc);
--   * bilesenin birim_agirlik'i varsa -> carpan × agirlik (uc; boyut uyusmazsa bilinmez);
--   * bilesenin aktif agaci varsa -> carpanla acilmaya devam (boyut uyusmazsa bilinmez);
--   * ikisi de yoksa: hammadde -> bilinmez; diger tip (sarf, aksesuar) sayilmaz;
--   * herhangi bir dalda bilinmez varsa kok NULL; derinlik 30 (dongu korumasi).
--   carpan = ust carpan × miktar × satir birimi temel carpani ÷ bilesen stok birimi temel carpani.
-- cekirdek.kalem_agirlik_kg(kalem) degismez (tek kalem cagrisi ve karsilastirma icin); tests/fason_tarifesi.test.js iki
-- yolun ayni sonucu verdigini denetler. fason_fiyat_v agirligi kume fonksiyonundan okur.

SELECT sistem.baglam_kur('kurulum', NULL, '0056_agirlik_kume_hesabi', 'kalem agirligi kume hesabi');

CREATE OR REPLACE FUNCTION cekirdek.kalem_agirliklari_kg(p_kokler uuid[])
RETURNS TABLE (kalem_id uuid, kg numeric) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE
  kalem AS (
    SELECT k.id, k.tip, b.boyut, b.temel_carpan,
           CASE WHEN jsonb_typeof(k.ozellik -> 'birim_agirlik') = 'number' AND (k.ozellik ->> 'birim_agirlik')::numeric > 0
                THEN (k.ozellik ->> 'birim_agirlik')::numeric END AS agirlik,
           (SELECT a.id FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif' AND a.baglam_kalem_id IS NULL) AS genel_agac,
           EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif') AS agacli
    FROM cekirdek.kalem k LEFT JOIN cekirdek.birim b ON b.kod = k.stok_birimi
  ),
  -- acilacak dugumler: (kok, agac, carpan, derinlik)
  acilim AS (
    SELECT kk.id AS kok, kk.genel_agac AS agac, 1::numeric AS carpan, 0 AS derinlik
    FROM kalem kk WHERE kk.id = ANY (p_kokler) AND kk.agirlik IS NULL AND kk.genel_agac IS NOT NULL
    UNION ALL
    SELECT ac.kok, c.genel_agac, ac.carpan * st.miktar * sb.temel_carpan / c.temel_carpan, ac.derinlik + 1
    FROM acilim ac
    JOIN cekirdek.urun_agaci_satir st ON st.agac_id = ac.agac
    JOIN kalem c ON c.id = st.bilesen_kalem_id
    JOIN cekirdek.birim sb ON sb.kod = st.birim
    WHERE ac.derinlik < 30 AND sb.boyut <> 'kutle' AND c.agirlik IS NULL AND c.genel_agac IS NOT NULL
      AND sb.boyut = c.boyut
  ),
  -- her acilan agacin satirlari: katki (kg) ya da bilinmez
  katki AS (
    SELECT ac.kok,
           CASE WHEN sb.boyut = 'kutle' THEN ac.carpan * st.miktar * sb.temel_carpan
                WHEN c.agirlik IS NOT NULL AND sb.boyut = c.boyut THEN ac.carpan * st.miktar * sb.temel_carpan / c.temel_carpan * c.agirlik
                ELSE 0 END AS kg,
           CASE WHEN sb.boyut IS NULL THEN c.agirlik IS NOT NULL OR c.agacli OR c.tip = 'hammadde'
                WHEN sb.boyut = 'kutle' THEN false
                WHEN c.agirlik IS NOT NULL THEN sb.boyut IS DISTINCT FROM c.boyut
                WHEN c.genel_agac IS NOT NULL THEN sb.boyut IS DISTINCT FROM c.boyut OR ac.derinlik + 1 > 30
                WHEN c.agacli THEN true                                   -- yalniz urune ozel agaci var: genel agirlik yok
                ELSE c.tip = 'hammadde' END AS bilinmez
    FROM acilim ac
    JOIN cekirdek.urun_agaci_satir st ON st.agac_id = ac.agac
    JOIN kalem c ON c.id = st.bilesen_kalem_id
    LEFT JOIN cekirdek.birim sb ON sb.kod = st.birim
  )
  SELECT kk.id,
         CASE WHEN kk.agirlik IS NOT NULL THEN kk.agirlik
              WHEN kk.genel_agac IS NULL THEN NULL
              WHEN bool_or(kt.bilinmez) THEN NULL
              ELSE COALESCE(sum(kt.kg), 0) END
  FROM kalem kk LEFT JOIN katki kt ON kt.kok = kk.id
  WHERE kk.id = ANY (p_kokler)
  GROUP BY kk.id, kk.agirlik, kk.genel_agac
$$;
ALTER FUNCTION cekirdek.kalem_agirliklari_kg(uuid[]) SET search_path = '';
COMMENT ON FUNCTION cekirdek.kalem_agirliklari_kg(uuid[]) IS
  'Kalem agirliklari (kg / stok birimi) kumede tek sorguda; kural cekirdek.kalem_agirlik_kg ile ayni (0056).';

CREATE OR REPLACE VIEW cekirdek.fason_fiyat_v WITH (security_invoker = true) AS
WITH adim AS (
  SELECT a.id AS rota_adim_id, r.kalem_id, a.dis_tedarik_birim_fiyat AS adim_fiyati,
         o.fason_birim_fiyat AS tarife, o.fason_fiyat_birimi AS tarife_birimi,
         (a.dis_tedarik_birim_fiyat IS NULL AND o.fason_fiyat_birimi = 'kg' AND o.fason_birim_fiyat IS NOT NULL) AS agirlik_gerekli
  FROM cekirdek.rota_adim a
  JOIN cekirdek.rota r ON r.id = a.rota_id
  JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol = 'dis_tedarik'
), agirlik AS (
  -- Agirlik yalniz kg tarifesi gereken kalemler icin, kumede bir kez.
  SELECT w.kalem_id, w.kg FROM cekirdek.kalem_agirliklari_kg(ARRAY(SELECT DISTINCT kalem_id FROM adim WHERE agirlik_gerekli)) w
), x AS (
  SELECT ad.rota_adim_id, ad.kalem_id, ad.adim_fiyati, ad.tarife, ad.tarife_birimi,
         CASE WHEN ad.agirlik_gerekli THEN ag.kg END AS agirlik_kg
  FROM adim ad LEFT JOIN agirlik ag ON ag.kalem_id = ad.kalem_id
)
SELECT x.rota_adim_id, x.kalem_id,
       CASE WHEN x.adim_fiyati IS NOT NULL THEN x.adim_fiyati
            WHEN x.tarife IS NULL THEN NULL
            WHEN x.tarife_birimi = 'adet' THEN x.tarife
            ELSE x.tarife * x.agirlik_kg END AS fiyat,
       CASE WHEN x.adim_fiyati IS NOT NULL THEN 'adim'
            WHEN x.tarife IS NULL THEN 'yok'
            WHEN x.tarife_birimi = 'adet' THEN 'operasyon'
            WHEN x.agirlik_kg IS NULL THEN 'agirlik_yok'
            ELSE 'operasyon_kg' END AS kaynak,
       x.tarife, x.tarife_birimi, x.agirlik_kg
FROM x;
`,oi=`-- 0058 · RECETE DENETIMI (eski UYS "Robot Denetci" recete kurallarinin genel karsiligi)
--
-- Serdar (17 Eyl): "eski programdaki gibi receteler icin robot olacak mi?" Urunde denetim canli dedektor motorudur
-- (0008, 0055): kayit degisince yalniz etkilenen kalem yeniden denetlenir, bulgu aninda acilir/kapanir; veriye
-- dokunmaz (ilke 8). Firma sabiti yok. Bu migration recete/rota icin yeni kurallar ekler:
--
--   D-URETILEN-ROTASIZ        (uyari)  aktif agaci olan (uretilen) kalemin aktif rotasi yok: kapasiteye, sahaya,
--                                      iscilik maliyetine girmez.
--   D-AGACTA-PASIF-BILESEN    (kritik) aktif agacta pasif (kullanimdan kalkmis) bilesen: MRP pasif kalemi planlar.
--   D-AGIRLIK-RECETE-SAPMA    (uyari)  kartta yazan birim agirlik, receteden hesaplanan agirliktan %15'ten fazla farkli.
--   D-ROTA-ISTASYON-UYUMSUZ   (uyari)  rota adimina yazilan is merkezi, operasyonun yapilabildigi istasyonlardan
--                                      biri degil (0046 bolum/istasyon kurali; kural 'tum' ise denetlenmez).
--   D-AGAC-FIRE-ASIRI         (uyari)  agac satiri firesi %50 ve ustu: cogu zaman oran yerine yuzde yazilmistir.
--   D-URUNE-OZEL-COK          (bilgi)  ayni kalemin 3+ urune ozel agaci var: icerik urune gore degisiyor; ayri kod
--                                      gerekebilir.
--
-- Eski robottaki "bir urunde yaprak, digerinde kirilimli" kurali urunun tek seviyeli modelinde veride olusmaz:
-- girintili aktarim onu yakalayip raporlar (aktarim uyarisi), kayitli agacta kalemin agaci ya vardir ya yoktur.

SELECT sistem.baglam_kur('kurulum', NULL, '0058_recete_denetimi', 'recete denetimi dedektorleri');

-- Kalemin RECETEDEN agirligi: kartindaki birim_agirlik'i YOK SAYAR (sapma denetimi icin); bilesenler 0048 kuraliyla.
CREATE OR REPLACE FUNCTION cekirdek.kalem_recete_agirligi_kg(p_kalem uuid)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_agac uuid;
  v_toplam numeric := 0;
  v_parca numeric;
  s record;
BEGIN
  SELECT a.id INTO v_agac FROM cekirdek.urun_agaci a WHERE a.kalem_id = p_kalem AND a.durum = 'aktif' AND a.baglam_kalem_id IS NULL;
  IF v_agac IS NULL THEN RETURN NULL; END IF;
  FOR s IN
    SELECT st.miktar, sb.boyut AS satir_boyut, sb.temel_carpan AS satir_carpan,
           kb.boyut AS stok_boyut, kb.temel_carpan AS stok_carpan, b.id AS bilesen, b.tip,
           EXISTS (SELECT 1 FROM cekirdek.urun_agaci x WHERE x.kalem_id = b.id AND x.durum = 'aktif') AS agacli
    FROM cekirdek.urun_agaci_satir st
    JOIN cekirdek.kalem b ON b.id = st.bilesen_kalem_id
    LEFT JOIN cekirdek.birim sb ON sb.kod = st.birim
    LEFT JOIN cekirdek.birim kb ON kb.kod = b.stok_birimi
    WHERE st.agac_id = v_agac
  LOOP
    IF s.satir_boyut = 'kutle' THEN
      v_toplam := v_toplam + s.miktar * s.satir_carpan;
      CONTINUE;
    END IF;
    v_parca := cekirdek.kalem_agirlik_kg(s.bilesen, 1);
    IF v_parca IS NULL THEN
      IF s.tip = 'hammadde' OR s.agacli THEN RETURN NULL; END IF;
      CONTINUE;
    END IF;
    IF s.satir_boyut IS NULL OR s.stok_boyut IS NULL OR s.satir_boyut <> s.stok_boyut THEN RETURN NULL; END IF;
    v_toplam := v_toplam + s.miktar * s.satir_carpan / s.stok_carpan * v_parca;
  END LOOP;
  RETURN v_toplam;
END $$;
ALTER FUNCTION cekirdek.kalem_recete_agirligi_kg(uuid) SET search_path = '';
COMMENT ON FUNCTION cekirdek.kalem_recete_agirligi_kg(uuid) IS
  'Kalemin genel agacindan hesaplanan kg agirligi; kalemin kendi birim_agirlik alani yok sayilir (0058 sapma denetimi).';

INSERT INTO sistem.dedektor (kod, ad, varlik, onem, aciklama, cozum, sorgu, bagimlilik) VALUES

('D-URETILEN-ROTASIZ', 'Üretilen kalemin rotası yok', 'cekirdek.kalem', 'uyari',
 'Kalemin aktif ürün ağacı var (üretiliyor) ama aktif rotası yok. Üretim emri kapasite çizelgesine girmez, sahada hiçbir operatörün listesinde görünmez, işçilik maliyeti sayılmaz.',
 'Malzeme kartında Rota sekmesinden en az bir iş adımı ekleyin; kalem fasoncudan hazır geliyorsa kartta "hazır alınır" işaretleyin.',
 $q$SELECT k.id::text AS kayit_id,
          format('%s (%s) üretiliyor ama rotası (iş adımı) yok', k.kod, k.tip) AS mesaj,
          '{}'::jsonb AS ayrinti
   FROM cekirdek.kalem k
   WHERE ($1::text[] IS NULL OR k.id = ANY ($1::uuid[]))
     AND k.aktif AND k.tip IN ('mamul','yari_mamul') AND k.planlama_yontemi <> 'planlanmaz'
     AND COALESCE((k.ozellik ->> 'hazir_alinir')::boolean, false) = false
     AND COALESCE((k.ozellik ->> 'fantom')::boolean, false) = false
     AND EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif')
     AND NOT EXISTS (SELECT 1 FROM cekirdek.rota r WHERE r.kalem_id = k.id AND r.durum = 'aktif')$q$,
 $b$[
   {"tablo":"cekirdek.kalem","kayit":"id"},
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.rota","kayit":"kalem_id"}
 ]$b$),

('D-AGACTA-PASIF-BILESEN', 'Aktif ağaçta pasif bileşen', 'cekirdek.kalem', 'kritik',
 'Kalemin aktif ürün ağacında kullanımdan kaldırılmış (pasif) bir bileşen var. MRP pasif kalemi yine planlar ve satın alma/üretim önerir.',
 'Reçete sekmesinde pasif bileşeni geçerli kalemle değiştirip yeni sürüm kaydedin ya da bileşeni yeniden aktif yapın.',
 $q$SELECT k.id::text AS kayit_id,
          format('%s ağacında pasif bileşen: %s', k.kod, string_agg(DISTINCT b.kod, ', ' ORDER BY b.kod)) AS mesaj,
          jsonb_build_object('bilesenler', jsonb_agg(DISTINCT b.kod)) AS ayrinti
   FROM cekirdek.kalem k
   JOIN cekirdek.urun_agaci a ON a.kalem_id = k.id AND a.durum = 'aktif'
   JOIN cekirdek.urun_agaci_satir s ON s.agac_id = a.id
   JOIN cekirdek.kalem b ON b.id = s.bilesen_kalem_id AND NOT b.aktif
   WHERE ($1::text[] IS NULL OR k.id = ANY ($1::uuid[]))
     AND k.aktif
   GROUP BY k.id, k.kod$q$,
 $b$[
   {"tablo":"cekirdek.kalem","sorgu":"SELECT $1->>'id' UNION SELECT a.kalem_id::text FROM cekirdek.urun_agaci_satir s JOIN cekirdek.urun_agaci a ON a.id = s.agac_id WHERE s.bilesen_kalem_id = ($1->>'id')::uuid"},
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT a.kalem_id::text FROM cekirdek.urun_agaci a WHERE a.id = ($1->>'agac_id')::uuid"}
 ]$b$),

('D-AGIRLIK-RECETE-SAPMA', 'Kart ağırlığı reçeteden farklı', 'cekirdek.kalem', 'uyari',
 'Kalem kartındaki birim ağırlık, ürün ağacındaki hammaddelerden hesaplanan ağırlıktan %15''ten fazla farklı. Fason kg fiyatı ve nakliye hesapları karttaki değeri kullanır; ya kart ya reçete yanlış.',
 'Kart ağırlığını tartım ya da çizimle doğrulayın; reçete miktarı yanlışsa Reçete sekmesinden düzeltin.',
 $q$SELECT x.id::text AS kayit_id,
          format('%s: kartta %s kg, reçeteden %s kg (fark %%%s)', x.kod, round(x.kart, 3), round(x.recete, 3), round(abs(x.kart - x.recete) / x.kart * 100)) AS mesaj,
          jsonb_build_object('kart_kg', x.kart, 'recete_kg', x.recete) AS ayrinti
   FROM (
     SELECT k.id, k.kod, (k.ozellik ->> 'birim_agirlik')::numeric AS kart, cekirdek.kalem_recete_agirligi_kg(k.id) AS recete
     FROM cekirdek.kalem k
     WHERE ($1::text[] IS NULL OR k.id = ANY ($1::uuid[]))
       AND k.aktif AND jsonb_typeof(k.ozellik -> 'birim_agirlik') = 'number' AND (k.ozellik ->> 'birim_agirlik')::numeric > 0
       AND EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif' AND a.baglam_kalem_id IS NULL)
     OFFSET 0
   ) x
   WHERE x.recete IS NOT NULL AND x.recete > 0 AND abs(x.kart - x.recete) / x.kart > 0.15$q$,
 $b$[
   {"tablo":"cekirdek.kalem","sorgu":"SELECT $1->>'id' UNION SELECT a.kalem_id::text FROM cekirdek.urun_agaci_satir s JOIN cekirdek.urun_agaci a ON a.id = s.agac_id AND a.durum = 'aktif' WHERE s.bilesen_kalem_id = ($1->>'id')::uuid"},
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT a.kalem_id::text FROM cekirdek.urun_agaci a WHERE a.id = ($1->>'agac_id')::uuid"}
 ]$b$),

('D-ROTA-ISTASYON-UYUMSUZ', 'Rota adımının istasyonu operasyona uymuyor', 'cekirdek.kalem', 'uyari',
 'Rota adımına yazılan iş merkezi, o operasyonun yapılabildiği istasyonlardan biri değil (Bölümler ekranındaki operasyon/bölüm bağları). Adım kapasitede yanlış istasyona yazılır, sahada o istasyonun operatörü işi görmez.',
 'Rota sekmesinde adımın iş merkezini düzeltin ya da boş bırakın (boş adım yapılabilir istasyonlara dağıtılır); bağ eksikse Bölümler ekranından operasyona istasyonu ekleyin.',
 $q$SELECT r.kalem_id::text AS kayit_id,
          format('%s rotası: %s', k.kod, string_agg(format('%s. %s → %s', a.sira, o.kod, m.kod), ' · ' ORDER BY a.sira)) AS mesaj,
          jsonb_build_object('adimlar', jsonb_agg(a.id ORDER BY a.sira)) AS ayrinti
   FROM cekirdek.rota r
   JOIN cekirdek.kalem k ON k.id = r.kalem_id
   JOIN cekirdek.rota_adim a ON a.rota_id = r.id AND a.is_merkezi_id IS NOT NULL
   JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol <> 'dis_tedarik'
   JOIN cekirdek.is_merkezi m ON m.id = a.is_merkezi_id
   WHERE ($1::text[] IS NULL OR r.kalem_id = ANY ($1::uuid[]))
     AND r.durum = 'aktif'
     AND EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v y WHERE y.operasyon_id = o.id AND y.neden <> 'tum')
     AND NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v y WHERE y.operasyon_id = o.id AND y.is_merkezi_id = a.is_merkezi_id)
   GROUP BY r.kalem_id, k.kod$q$,
 $b$[
   {"tablo":"cekirdek.rota","kayit":"kalem_id"},
   {"tablo":"cekirdek.rota_adim","sorgu":"SELECT kalem_id::text FROM cekirdek.rota WHERE id = ($1->>'rota_id')::uuid"},
   {"tablo":"cekirdek.operasyon_is_merkezi","sorgu":"SELECT DISTINCT r.kalem_id::text FROM cekirdek.rota_adim a JOIN cekirdek.rota r ON r.id = a.rota_id AND r.durum = 'aktif' WHERE a.operasyon_id = ($1->>'operasyon_id')::uuid"},
   {"tablo":"cekirdek.bolum_operasyon","sorgu":"SELECT DISTINCT r.kalem_id::text FROM cekirdek.rota_adim a JOIN cekirdek.rota r ON r.id = a.rota_id AND r.durum = 'aktif' WHERE a.operasyon_id = ($1->>'operasyon_id')::uuid"},
   {"tablo":"cekirdek.operasyon","sorgu":"SELECT DISTINCT r.kalem_id::text FROM cekirdek.rota_adim a JOIN cekirdek.rota r ON r.id = a.rota_id AND r.durum = 'aktif' WHERE a.operasyon_id = ($1->>'id')::uuid"},
   {"tablo":"cekirdek.is_merkezi","sorgu":"SELECT DISTINCT r.kalem_id::text FROM cekirdek.rota_adim a JOIN cekirdek.rota r ON r.id = a.rota_id AND r.durum = 'aktif' WHERE a.is_merkezi_id = ($1->>'id')::uuid OR a.operasyon_id IN (SELECT operasyon_id FROM cekirdek.bolum_operasyon WHERE bolum_id = ($1->>'bolum_id')::uuid)"}
 ]$b$),

('D-AGAC-FIRE-ASIRI', 'Ağaç satırında aşırı fire', 'cekirdek.kalem', 'uyari',
 'Ürün ağacı satırında fire oranı %50 ya da üstü. Fire oran olarak girilir (0,05 = %5); yüzde olarak yazılmış bir değer malzeme ihtiyacını katlar.',
 'Reçete sekmesinde fireyi kontrol edin; %5 için 5 değil 0,05 yazılır.',
 $q$SELECT a.kalem_id::text AS kayit_id,
          format('%s ağacı: %s', k.kod, string_agg(format('%s fire %%%s', b.kod, round(s.fire_orani * 100)), ' · ' ORDER BY s.sira)) AS mesaj,
          jsonb_build_object('satirlar', jsonb_agg(s.id ORDER BY s.sira)) AS ayrinti
   FROM cekirdek.urun_agaci a
   JOIN cekirdek.kalem k ON k.id = a.kalem_id
   JOIN cekirdek.urun_agaci_satir s ON s.agac_id = a.id AND s.fire_orani >= 0.5
   JOIN cekirdek.kalem b ON b.id = s.bilesen_kalem_id
   WHERE ($1::text[] IS NULL OR a.kalem_id = ANY ($1::uuid[]))
     AND a.durum = 'aktif'
   GROUP BY a.kalem_id, k.kod$q$,
 $b$[
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"},
   {"tablo":"cekirdek.urun_agaci_satir","sorgu":"SELECT a.kalem_id::text FROM cekirdek.urun_agaci a WHERE a.id = ($1->>'agac_id')::uuid"}
 ]$b$),

('D-URUNE-OZEL-COK', 'Kalemin içeriği ürüne göre çok farklı', 'cekirdek.kalem', 'bilgi',
 'Aynı kalemin üç ya da daha fazla ürüne özel ağacı var: içeriği kullanıldığı ürüne göre değişiyor. Bu çoğu zaman tek kodun farklı parçalara verildiğini gösterir; stok ve maliyet ürün ayırt etmeden tek kalemde toplanır.',
 'Farklı içerikler gerçekten farklı parçaysa her birine ayrı kod verin; aynı parçaysa ürüne özel ağaçları genel ağaçta birleştirin.',
 $q$SELECT k.id::text AS kayit_id,
          format('%s %s ürüne özel ağaçla kullanılıyor', k.kod, u.sayi) AS mesaj,
          jsonb_build_object('urune_ozel_agac', u.sayi) AS ayrinti
   FROM cekirdek.kalem k
   JOIN LATERAL (SELECT count(*)::int AS sayi FROM cekirdek.urun_agaci a
                 WHERE a.kalem_id = k.id AND a.durum = 'aktif' AND a.baglam_kalem_id IS NOT NULL) u ON u.sayi >= 3
   WHERE ($1::text[] IS NULL OR k.id = ANY ($1::uuid[]))
     AND k.aktif$q$,
 $b$[
   {"tablo":"cekirdek.kalem","kayit":"id"},
   {"tablo":"cekirdek.urun_agaci","kayit":"kalem_id"}
 ]$b$);
`,ui=`-- 0059 · KURULUM KONTROL LISTESI — firma "kullanima hazir mi?" sorusunun tek cevabi
--
-- Hedef: Serdar gelistirici olmadan yeni firmayi kurabilsin. Ozler pilotunda (17 Eyl) eksikler tek tek, canli
-- uctan uca denemede bulundu: depo yoktu (mal kabul/sevk hata), istasyon kapasitesi bostu (cizelge sinirsiz),
-- saat maliyeti yoktu (iscilik bos), rota adimlarinda istasyon cozulmuyordu (sahada is gorunmuyor), fiyat yoktu.
-- Bunlarin hicbiri veri hatasi degil, KURULUM eksigidir; kurulum sihirbazinin Ozet adimi okur.
--
-- sistem.kurulum_kontrol_v: sira, konu, baslik, durum ('tamam' | 'uyari' | 'eksik'), sayi, aciklama, cozum.
--   eksik : program o akisi calistiramaz (depo yok, istasyon yok...).
--   uyari : calisir ama sonuc eksik/yaniltici (kapasite, maliyet, fiyat, bulgu).
-- Salt okuma; hic bir sey yazmaz. Kontroller genel (firma sabiti yok).

SELECT sistem.baglam_kur('kurulum', NULL, '0059_kurulum_kontrol', 'kurulum kontrol listesi');

CREATE VIEW sistem.kurulum_kontrol_v WITH (security_invoker = true) AS
WITH s AS (
  SELECT
    (SELECT count(*) FROM sistem.firma) AS firma,
    (SELECT count(*) FROM cekirdek.depo WHERE aktif) AS depo,
    (SELECT count(*) FROM cekirdek.kalem WHERE aktif) AS kalem,
    (SELECT count(*) FROM cekirdek.is_merkezi WHERE aktif) AS istasyon,
    (SELECT count(*) FROM cekirdek.operasyon WHERE aktif) AS operasyon,
    -- kapasite ve saat maliyeti yalniz KULLANILAN istasyonda anlamli (rota adimi, varsayilan ya da bolum/istasyon bagi)
    (SELECT count(*) FROM cekirdek.is_merkezi m WHERE m.aktif AND m.gunluk_kapasite_saat IS NULL
       AND (EXISTS (SELECT 1 FROM cekirdek.rota_adim ra WHERE ra.is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon oo WHERE oo.varsayilan_is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v yy WHERE yy.is_merkezi_id = m.id AND yy.neden <> 'tum'))) AS kapasitesiz,
    (SELECT count(*) FROM cekirdek.is_merkezi m JOIN cekirdek.is_merkezi_maliyet_v v ON v.is_merkezi_id = m.id
      WHERE m.aktif AND v.saat_maliyeti IS NULL
        AND (EXISTS (SELECT 1 FROM cekirdek.rota_adim ra WHERE ra.is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon oo WHERE oo.varsayilan_is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v yy WHERE yy.is_merkezi_id = m.id AND yy.neden <> 'tum'))) AS saat_maliyetsiz,
    (SELECT count(*) FROM cekirdek.rota r JOIN cekirdek.rota_adim a ON a.rota_id = r.id
       JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol <> 'dis_tedarik'
      WHERE r.durum = 'aktif' AND a.is_merkezi_id IS NULL AND o.varsayilan_is_merkezi_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v y WHERE y.operasyon_id = o.id AND y.neden <> 'tum')) AS istasyonsuz_adim,
    (SELECT count(*) FROM cekirdek.kalem k
      WHERE k.aktif AND k.tip NOT IN ('mamul','yari_mamul')
        AND EXISTS (SELECT 1 FROM cekirdek.urun_agaci_satir st JOIN cekirdek.urun_agaci a ON a.id = st.agac_id AND a.durum = 'aktif' WHERE st.bilesen_kalem_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif')
        AND (k.ozellik ->> 'standart_maliyet') IS NULL AND (k.ozellik ->> 'son_alis_fiyati') IS NULL
        AND NOT EXISTS (SELECT 1 FROM cekirdek.tedarik_kosulu t WHERE t.kalem_id = k.id AND t.varsayilan AND t.aktif AND t.birim_fiyat IS NOT NULL)) AS fiyatsiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod IN ('D-URETILEN-AGACSIZ','D-AGACTA-KULLANILAN-AGACSIZ')) AS agacsiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod IN ('D-URETILEN-ROTASIZ')) AS rotasiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod = 'D-FASON-FIYAT-YOK') AS fason_fiyatsiz,
    (SELECT count(*) FROM sistem.bulgu b JOIN sistem.dedektor d ON d.kod = b.dedektor_kod WHERE b.durum = 'acik' AND d.onem = 'kritik') AS kritik,
    (SELECT count(*) FROM sistem.kullanici ku WHERE ku.aktif
       AND EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND '*' = ANY (r.izinler))) AS yonetici
)
SELECT x.sira, x.konu, x.baslik,
       CASE WHEN x.sayi IS NULL THEN 'tamam' WHEN x.eksik_mi THEN 'eksik' ELSE 'uyari' END AS durum,
       x.sayi, x.aciklama, x.cozum
FROM s CROSS JOIN LATERAL (VALUES
  (10, 'firma', 'Firma bilgisi', CASE WHEN s.firma = 0 THEN 1 END, true,
   'Firma adı, para birimi ve saat dilimi tanımlı değil.', 'Kurulum sihirbazı 1. adım.'),
  (20, 'depo', 'Depo', CASE WHEN s.depo = 0 THEN 1 END, true,
   'Aktif depo yok: mal kabul, üretim tamamlama ve sevk çalışmaz.', 'Depo ekranından en az bir depo ekleyin.'),
  (30, 'kalem', 'Malzemeler', CASE WHEN s.kalem = 0 THEN 1 END, true,
   'Hiç malzeme kartı yok.', 'Kurulum sihirbazı Veriler adımında Malzemeler dosyasını yükleyin.'),
  (40, 'istasyon', 'İş merkezleri', CASE WHEN s.istasyon = 0 THEN 1 END, true,
   'Hiç iş merkezi (istasyon) yok: rota, kapasite ve saha çalışmaz.', 'Veriler adımında İş merkezleri dosyasını yükleyin.'),
  (50, 'operasyon', 'Operasyonlar', CASE WHEN s.operasyon = 0 THEN 1 END, true,
   'Hiç operasyon yok: rota adımı tanımlanamaz.', 'Veriler adımında Operasyonlar dosyasını yükleyin.'),
  (60, 'agac', 'Ürün ağaçları', NULLIF(s.agacsiz, 0), false,
   'Üretilen kalemlerde ürün ağacı eksik: MRP malzeme ihtiyacını hesaplayamaz.', 'Veri kalitesi ekranındaki ağaçsız kalemleri Reçete sekmesinden tamamlayın ya da planlanmaz işaretleyin.'),
  (70, 'rota', 'Rotalar', NULLIF(s.rotasiz, 0), false,
   'Ağacı olan üretilen kalemlerde rota eksik: kapasite, saha ve işçilik maliyeti bu kalemleri görmez.', 'Malzeme kartında Rota sekmesinden iş adımı ekleyin.'),
  (80, 'rota_istasyon', 'Rota adımı istasyonu', NULLIF(s.istasyonsuz_adim, 0), false,
   'Rota adımında iş merkezi yok ve operasyonun ne varsayılan istasyonu ne bölüm/istasyon bağı var: adım hiçbir operatörün listesinde görünmez.', 'Bölümler ekranından operasyona bölüm ya da istasyon bağlayın.'),
  (90, 'kapasite', 'İstasyon kapasitesi', NULLIF(s.kapasitesiz, 0), false,
   'Kullanılan istasyonlardan günlük kapasitesi boş olanlar kapasite çizelgesinde sınırsız sayılır; gecikme hesabı anlamsız olur.', 'İş merkezleri dosyasında günlük kapasite (saat) girin.'),
  (100, 'saat_maliyeti', 'Saat maliyeti', NULLIF(s.saat_maliyetsiz, 0), false,
   'Kullanılan istasyonlarda saat maliyeti ne istasyonda ne bölümünde tanımlı: bu istasyonlardaki işçilik maliyete girmez.', 'Bölümler ekranında bölüm saat maliyetini girin.'),
  (110, 'fiyat', 'Satın alma fiyatları', NULLIF(s.fiyatsiz, 0), false,
   'Reçetelerde kullanılan satın alma kalemlerinin fiyatı yok: ürün maliyeti boş çıkar.', 'Malzemeler dosyasında Standart maliyet sütununu ya da Tedarik koşulları dosyasını doldurun.'),
  (120, 'fason', 'Fason fiyatları', NULLIF(s.fason_fiyatsiz, 0), false,
   'Dış tedarik adımlarının fiyatı çıkmıyor: ürün maliyeti boş kalır.', 'Operasyon kartına fason fiyatı (adet ya da kg) girin.'),
  (130, 'kritik', 'Kritik veri bulguları', NULLIF(s.kritik, 0), false,
   'Açık kritik bulgu var: planlama sonucu eksik ya da yanlış olabilir.', 'Veri kalitesi ekranında kritik bulguları kapatın.'),
  (140, 'yonetici', 'Tam yetkili kullanıcı', CASE WHEN s.yonetici = 0 THEN 1 END, false,
   'Tam yetkili aktif kullanıcı yok (sunucu kurulumunda gerekir; tarayıcı kipinde yetki denetimi yoktur).', 'Kullanıcılar ekranından yönetici rolü verin.')
) AS x(sira, konu, baslik, sayi, eksik_mi, aciklama, cozum);

COMMENT ON VIEW sistem.kurulum_kontrol_v IS 'Firma kullanima hazir mi: eksik (akis calismaz) / uyari (sonuc eksik) / tamam (0059).';
GRANT SELECT ON sistem.kurulum_kontrol_v TO authenticated;
`,_i=`-- 0060 · KURULUM KONTROLUNE SAHA SATIRLARI — duruş nedeni katalogu ve operatör hesabı bağı
--
-- 0059 kurulum kontrolu uretim/maliyet tarafini kapsiyor; SAHA (tablet) tarafi iki sessiz eksikle duruyor:
--   * Durus nedeni yoksa operator durus bildiremez: kayipsuresi hic gorunmez, OEE kullanilabilirligi %100 sanilir.
--     (Durus ve problem ekrani bu durumda zaten uyariyor; kurulum ozetinde de gorunmeli.)
--   * Operator hesabi bir KAYNAGA bagli degilse (sema 0042 kullanici.kaynak_id) sahada "Ben" secimi bostur:
--     kayit kimseye yazilmaz, operator verimliligi ve vardiya raporu bos kalir.
-- Uyari (eksik degil): program calisir, sonuc eksik kalir. Yalniz SUNUCU kipinde anlamlidir; tarayici kipinde
-- kullanici tablosu bos olabilir, o yuzden operator satiri yalniz operator rollu kullanici varken sayar.

SELECT sistem.baglam_kur('kurulum', NULL, '0060_kurulum_kontrol_saha', 'kurulum kontrolu: saha satirlari');

CREATE OR REPLACE VIEW sistem.kurulum_kontrol_v WITH (security_invoker = true) AS
WITH s AS (
  SELECT
    (SELECT count(*) FROM sistem.firma) AS firma,
    (SELECT count(*) FROM cekirdek.depo WHERE aktif) AS depo,
    (SELECT count(*) FROM cekirdek.kalem WHERE aktif) AS kalem,
    (SELECT count(*) FROM cekirdek.is_merkezi WHERE aktif) AS istasyon,
    (SELECT count(*) FROM cekirdek.operasyon WHERE aktif) AS operasyon,
    -- kapasite ve saat maliyeti yalniz KULLANILAN istasyonda anlamli (rota adimi, varsayilan ya da bolum/istasyon bagi)
    (SELECT count(*) FROM cekirdek.is_merkezi m WHERE m.aktif AND m.gunluk_kapasite_saat IS NULL
       AND (EXISTS (SELECT 1 FROM cekirdek.rota_adim ra WHERE ra.is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon oo WHERE oo.varsayilan_is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v yy WHERE yy.is_merkezi_id = m.id AND yy.neden <> 'tum'))) AS kapasitesiz,
    (SELECT count(*) FROM cekirdek.is_merkezi m JOIN cekirdek.is_merkezi_maliyet_v v ON v.is_merkezi_id = m.id
      WHERE m.aktif AND v.saat_maliyeti IS NULL
        AND (EXISTS (SELECT 1 FROM cekirdek.rota_adim ra WHERE ra.is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon oo WHERE oo.varsayilan_is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v yy WHERE yy.is_merkezi_id = m.id AND yy.neden <> 'tum'))) AS saat_maliyetsiz,
    (SELECT count(*) FROM cekirdek.rota r JOIN cekirdek.rota_adim a ON a.rota_id = r.id
       JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol <> 'dis_tedarik'
      WHERE r.durum = 'aktif' AND a.is_merkezi_id IS NULL AND o.varsayilan_is_merkezi_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v y WHERE y.operasyon_id = o.id AND y.neden <> 'tum')) AS istasyonsuz_adim,
    (SELECT count(*) FROM cekirdek.kalem k
      WHERE k.aktif AND k.tip NOT IN ('mamul','yari_mamul')
        AND EXISTS (SELECT 1 FROM cekirdek.urun_agaci_satir st JOIN cekirdek.urun_agaci a ON a.id = st.agac_id AND a.durum = 'aktif' WHERE st.bilesen_kalem_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif')
        AND (k.ozellik ->> 'standart_maliyet') IS NULL AND (k.ozellik ->> 'son_alis_fiyati') IS NULL
        AND NOT EXISTS (SELECT 1 FROM cekirdek.tedarik_kosulu t WHERE t.kalem_id = k.id AND t.varsayilan AND t.aktif AND t.birim_fiyat IS NOT NULL)) AS fiyatsiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod IN ('D-URETILEN-AGACSIZ','D-AGACTA-KULLANILAN-AGACSIZ')) AS agacsiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod IN ('D-URETILEN-ROTASIZ')) AS rotasiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod = 'D-FASON-FIYAT-YOK') AS fason_fiyatsiz,
    (SELECT count(*) FROM sistem.bulgu b JOIN sistem.dedektor d ON d.kod = b.dedektor_kod WHERE b.durum = 'acik' AND d.onem = 'kritik') AS kritik,
    (SELECT count(*) FROM sistem.kullanici ku WHERE ku.aktif
       AND EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND '*' = ANY (r.izinler))) AS yonetici,
    -- SAHA (0060)
    (SELECT count(*) FROM cekirdek.durus_nedeni WHERE aktif) AS durus_nedeni,
    (SELECT count(*) FROM sistem.kullanici ku WHERE ku.aktif AND ku.kaynak_id IS NULL
       AND EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND 'yazma:operasyon.*' = ANY (r.izinler))
       AND NOT EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND '*' = ANY (r.izinler))) AS kaynaksiz_operator
)
SELECT x.sira, x.konu, x.baslik,
       CASE WHEN x.sayi IS NULL THEN 'tamam' WHEN x.eksik_mi THEN 'eksik' ELSE 'uyari' END AS durum,
       x.sayi, x.aciklama, x.cozum
FROM s CROSS JOIN LATERAL (VALUES
  (10, 'firma', 'Firma bilgisi', CASE WHEN s.firma = 0 THEN 1 END, true,
   'Firma adı, para birimi ve saat dilimi tanımlı değil.', 'Kurulum sihirbazı 1. adım.'),
  (20, 'depo', 'Depo', CASE WHEN s.depo = 0 THEN 1 END, true,
   'Aktif depo yok: mal kabul, üretim tamamlama ve sevk çalışmaz.', 'Depo ekranından en az bir depo ekleyin.'),
  (30, 'kalem', 'Malzemeler', CASE WHEN s.kalem = 0 THEN 1 END, true,
   'Hiç malzeme kartı yok.', 'Kurulum sihirbazı Veriler adımında Malzemeler dosyasını yükleyin.'),
  (40, 'istasyon', 'İş merkezleri', CASE WHEN s.istasyon = 0 THEN 1 END, true,
   'Hiç iş merkezi (istasyon) yok: rota, kapasite ve saha çalışmaz.', 'Veriler adımında İş merkezleri dosyasını yükleyin.'),
  (50, 'operasyon', 'Operasyonlar', CASE WHEN s.operasyon = 0 THEN 1 END, true,
   'Hiç operasyon yok: rota adımı tanımlanamaz.', 'Veriler adımında Operasyonlar dosyasını yükleyin.'),
  (60, 'agac', 'Ürün ağaçları', NULLIF(s.agacsiz, 0), false,
   'Üretilen kalemlerde ürün ağacı eksik: MRP malzeme ihtiyacını hesaplayamaz.', 'Veri kalitesi ekranındaki ağaçsız kalemleri Reçete sekmesinden tamamlayın ya da planlanmaz işaretleyin.'),
  (70, 'rota', 'Rotalar', NULLIF(s.rotasiz, 0), false,
   'Ağacı olan üretilen kalemlerde rota eksik: kapasite, saha ve işçilik maliyeti bu kalemleri görmez.', 'Malzeme kartında Rota sekmesinden iş adımı ekleyin.'),
  (80, 'rota_istasyon', 'Rota adımı istasyonu', NULLIF(s.istasyonsuz_adim, 0), false,
   'Rota adımında iş merkezi yok ve operasyonun ne varsayılan istasyonu ne bölüm/istasyon bağı var: adım hiçbir operatörün listesinde görünmez.', 'Bölümler ekranından operasyona bölüm ya da istasyon bağlayın.'),
  (90, 'kapasite', 'İstasyon kapasitesi', NULLIF(s.kapasitesiz, 0), false,
   'Kullanılan istasyonlardan günlük kapasitesi boş olanlar kapasite çizelgesinde sınırsız sayılır; gecikme hesabı anlamsız olur.', 'İş merkezleri dosyasında günlük kapasite (saat) girin.'),
  (100, 'saat_maliyeti', 'Saat maliyeti', NULLIF(s.saat_maliyetsiz, 0), false,
   'Kullanılan istasyonlarda saat maliyeti ne istasyonda ne bölümünde tanımlı: bu istasyonlardaki işçilik maliyete girmez.', 'Bölümler ekranında bölüm saat maliyetini girin.'),
  (110, 'fiyat', 'Satın alma fiyatları', NULLIF(s.fiyatsiz, 0), false,
   'Reçetelerde kullanılan satın alma kalemlerinin fiyatı yok: ürün maliyeti boş çıkar.', 'Malzemeler dosyasında Standart maliyet sütununu ya da Tedarik koşulları dosyasını doldurun.'),
  (120, 'fason', 'Fason fiyatları', NULLIF(s.fason_fiyatsiz, 0), false,
   'Dış tedarik adımlarının fiyatı çıkmıyor: ürün maliyeti boş kalır.', 'Operasyon kartına fason fiyatı (adet ya da kg) girin.'),
  (130, 'kritik', 'Kritik veri bulguları', NULLIF(s.kritik, 0), false,
   'Açık kritik bulgu var: planlama sonucu eksik ya da yanlış olabilir.', 'Veri kalitesi ekranında kritik bulguları kapatın.'),
  (140, 'yonetici', 'Tam yetkili kullanıcı', CASE WHEN s.yonetici = 0 THEN 1 END, false,
   'Tam yetkili aktif kullanıcı yok (sunucu kurulumunda gerekir; tarayıcı kipinde yetki denetimi yoktur).', 'Kullanıcılar ekranından yönetici rolü verin.'),
  (150, 'durus_nedeni', 'Duruş nedenleri', CASE WHEN s.durus_nedeni = 0 THEN 1 END, false,
   'Aktif duruş nedeni yok: sahada duruş bildirilemez, kayıp süre görünmez ve OEE kullanılabilirliği olduğundan iyi çıkar.', 'Duruş ve problem ekranında "Önerilen listeyi ekle" ile başlayın.'),
  (160, 'operator_kaynak', 'Operatör hesabı bağı', NULLIF(s.kaynaksiz_operator, 0), false,
   'Operatör hesabı bir kaynağa (operatör/makine kartı) bağlı değil: sahada "Ben" seçimi boş kalır, kayıt kimseye yazılmaz, operatör verimliliği ve vardiya raporu boş çıkar.', 'Kullanıcılar ekranında "Saha kaynağı" sütunundan hesabı kaynağa bağlayın.')
) AS x(sira, konu, baslik, sayi, eksik_mi, aciklama, cozum);

COMMENT ON VIEW sistem.kurulum_kontrol_v IS 'Firma kullanima hazir mi: eksik (akis calismaz) / uyari (sonuc eksik) / tamam (0059, saha satirlari 0060).';
GRANT SELECT ON sistem.kurulum_kontrol_v TO authenticated;
`,Ni=`-- 0061 · KURULUM KONTROLUNE TAHMINI DEGER SATIRI
--
-- 0059/0060 "program bu akisi calistirabiliyor mu"yu olcuyor. Eksik olan soru: SONUCA guvenilir mi? Ozler
-- pilotunda (17 Eyl) kurulum tahminlerle acildi — celik 38 TL/kg, istasyon kapasitesi 8 saat, bolum saat
-- maliyetleri, rotasiz mamullere tek adim montaj — ve bunlarin hepsi olay defterinde "TAHMINI" gerekcesiyle
-- duruyor (sistem.varsayim_v, 0051/0054). Maliyet ekraninda tek tek "tahmini" rozeti gorunuyor ama kurulumu
-- yapan kisi TOPLAM resmi hic gormuyor: "bu firmada 1.683 deger tahmin" cumlesini kimse soylemiyor.
--
-- Bu satir onu soyluyor. Durum 'uyari': program calisir, sonuc gercek veri gelince DEGISIR. Tahmini deger
-- birakmak gecerli bir kurulum bicimidir (Serdar 17 Eyl: "varsayimla ilerle"), gizlenmesi degil.
--
-- Maliyet: varsayim_v tahmini KAYIT sayisiyla olceklenir (olay tablosunun tamamiyla degil; olay_varsayim_idx
-- uzerinden aday kayitlar taranir). Ozler'de 1.683 kayitta 59 ms. Ozet adimi kurulumda acilan bir ekran,
-- sicak yol degil.

SELECT sistem.baglam_kur('kurulum', NULL, '0061_kurulum_kontrol_varsayim', 'kurulum kontrolu: tahmini deger satiri');

CREATE OR REPLACE VIEW sistem.kurulum_kontrol_v WITH (security_invoker = true) AS
WITH s AS (
  SELECT
    (SELECT count(*) FROM sistem.firma) AS firma,
    (SELECT count(*) FROM cekirdek.depo WHERE aktif) AS depo,
    (SELECT count(*) FROM cekirdek.kalem WHERE aktif) AS kalem,
    (SELECT count(*) FROM cekirdek.is_merkezi WHERE aktif) AS istasyon,
    (SELECT count(*) FROM cekirdek.operasyon WHERE aktif) AS operasyon,
    -- kapasite ve saat maliyeti yalniz KULLANILAN istasyonda anlamli (rota adimi, varsayilan ya da bolum/istasyon bagi)
    (SELECT count(*) FROM cekirdek.is_merkezi m WHERE m.aktif AND m.gunluk_kapasite_saat IS NULL
       AND (EXISTS (SELECT 1 FROM cekirdek.rota_adim ra WHERE ra.is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon oo WHERE oo.varsayilan_is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v yy WHERE yy.is_merkezi_id = m.id AND yy.neden <> 'tum'))) AS kapasitesiz,
    (SELECT count(*) FROM cekirdek.is_merkezi m JOIN cekirdek.is_merkezi_maliyet_v v ON v.is_merkezi_id = m.id
      WHERE m.aktif AND v.saat_maliyeti IS NULL
        AND (EXISTS (SELECT 1 FROM cekirdek.rota_adim ra WHERE ra.is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon oo WHERE oo.varsayilan_is_merkezi_id = m.id) OR EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v yy WHERE yy.is_merkezi_id = m.id AND yy.neden <> 'tum'))) AS saat_maliyetsiz,
    (SELECT count(*) FROM cekirdek.rota r JOIN cekirdek.rota_adim a ON a.rota_id = r.id
       JOIN cekirdek.operasyon o ON o.id = a.operasyon_id AND o.rol <> 'dis_tedarik'
      WHERE r.durum = 'aktif' AND a.is_merkezi_id IS NULL AND o.varsayilan_is_merkezi_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cekirdek.operasyon_yapilabilir_istasyon_v y WHERE y.operasyon_id = o.id AND y.neden <> 'tum')) AS istasyonsuz_adim,
    (SELECT count(*) FROM cekirdek.kalem k
      WHERE k.aktif AND k.tip NOT IN ('mamul','yari_mamul')
        AND EXISTS (SELECT 1 FROM cekirdek.urun_agaci_satir st JOIN cekirdek.urun_agaci a ON a.id = st.agac_id AND a.durum = 'aktif' WHERE st.bilesen_kalem_id = k.id)
        AND NOT EXISTS (SELECT 1 FROM cekirdek.urun_agaci a WHERE a.kalem_id = k.id AND a.durum = 'aktif')
        AND (k.ozellik ->> 'standart_maliyet') IS NULL AND (k.ozellik ->> 'son_alis_fiyati') IS NULL
        AND NOT EXISTS (SELECT 1 FROM cekirdek.tedarik_kosulu t WHERE t.kalem_id = k.id AND t.varsayilan AND t.aktif AND t.birim_fiyat IS NOT NULL)) AS fiyatsiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod IN ('D-URETILEN-AGACSIZ','D-AGACTA-KULLANILAN-AGACSIZ')) AS agacsiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod IN ('D-URETILEN-ROTASIZ')) AS rotasiz,
    (SELECT count(*) FROM sistem.bulgu WHERE durum = 'acik' AND dedektor_kod = 'D-FASON-FIYAT-YOK') AS fason_fiyatsiz,
    (SELECT count(*) FROM sistem.bulgu b JOIN sistem.dedektor d ON d.kod = b.dedektor_kod WHERE b.durum = 'acik' AND d.onem = 'kritik') AS kritik,
    (SELECT count(*) FROM sistem.kullanici ku WHERE ku.aktif
       AND EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND '*' = ANY (r.izinler))) AS yonetici,
    -- SAHA (0060)
    (SELECT count(*) FROM cekirdek.durus_nedeni WHERE aktif) AS durus_nedeni,
    (SELECT count(*) FROM sistem.kullanici ku WHERE ku.aktif AND ku.kaynak_id IS NULL
       AND EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND 'yazma:operasyon.*' = ANY (r.izinler))
       AND NOT EXISTS (SELECT 1 FROM sistem.rol r WHERE r.kod = ANY (ku.roller) AND '*' = ANY (r.izinler))) AS kaynaksiz_operator,
    -- GUVEN (0061): kac deger gercek veri degil tahmin
    (SELECT count(*) FROM sistem.varsayim_v) AS varsayim
)
SELECT x.sira, x.konu, x.baslik,
       CASE WHEN x.sayi IS NULL THEN 'tamam' WHEN x.eksik_mi THEN 'eksik' ELSE 'uyari' END AS durum,
       x.sayi, x.aciklama, x.cozum
FROM s CROSS JOIN LATERAL (VALUES
  (10, 'firma', 'Firma bilgisi', CASE WHEN s.firma = 0 THEN 1 END, true,
   'Firma adı, para birimi ve saat dilimi tanımlı değil.', 'Kurulum sihirbazı 1. adım.'),
  (20, 'depo', 'Depo', CASE WHEN s.depo = 0 THEN 1 END, true,
   'Aktif depo yok: mal kabul, üretim tamamlama ve sevk çalışmaz.', 'Depo ekranından en az bir depo ekleyin.'),
  (30, 'kalem', 'Malzemeler', CASE WHEN s.kalem = 0 THEN 1 END, true,
   'Hiç malzeme kartı yok.', 'Kurulum sihirbazı Veriler adımında Malzemeler dosyasını yükleyin.'),
  (40, 'istasyon', 'İş merkezleri', CASE WHEN s.istasyon = 0 THEN 1 END, true,
   'Hiç iş merkezi (istasyon) yok: rota, kapasite ve saha çalışmaz.', 'Veriler adımında İş merkezleri dosyasını yükleyin.'),
  (50, 'operasyon', 'Operasyonlar', CASE WHEN s.operasyon = 0 THEN 1 END, true,
   'Hiç operasyon yok: rota adımı tanımlanamaz.', 'Veriler adımında Operasyonlar dosyasını yükleyin.'),
  (60, 'agac', 'Ürün ağaçları', NULLIF(s.agacsiz, 0), false,
   'Üretilen kalemlerde ürün ağacı eksik: MRP malzeme ihtiyacını hesaplayamaz.', 'Veri kalitesi ekranındaki ağaçsız kalemleri Reçete sekmesinden tamamlayın ya da planlanmaz işaretleyin.'),
  (70, 'rota', 'Rotalar', NULLIF(s.rotasiz, 0), false,
   'Ağacı olan üretilen kalemlerde rota eksik: kapasite, saha ve işçilik maliyeti bu kalemleri görmez.', 'Malzeme kartında Rota sekmesinden iş adımı ekleyin.'),
  (80, 'rota_istasyon', 'Rota adımı istasyonu', NULLIF(s.istasyonsuz_adim, 0), false,
   'Rota adımında iş merkezi yok ve operasyonun ne varsayılan istasyonu ne bölüm/istasyon bağı var: adım hiçbir operatörün listesinde görünmez.', 'Bölümler ekranından operasyona bölüm ya da istasyon bağlayın.'),
  (90, 'kapasite', 'İstasyon kapasitesi', NULLIF(s.kapasitesiz, 0), false,
   'Kullanılan istasyonlardan günlük kapasitesi boş olanlar kapasite çizelgesinde sınırsız sayılır; gecikme hesabı anlamsız olur.', 'İş merkezleri dosyasında günlük kapasite (saat) girin.'),
  (100, 'saat_maliyeti', 'Saat maliyeti', NULLIF(s.saat_maliyetsiz, 0), false,
   'Kullanılan istasyonlarda saat maliyeti ne istasyonda ne bölümünde tanımlı: bu istasyonlardaki işçilik maliyete girmez.', 'Bölümler ekranında bölüm saat maliyetini girin.'),
  (110, 'fiyat', 'Satın alma fiyatları', NULLIF(s.fiyatsiz, 0), false,
   'Reçetelerde kullanılan satın alma kalemlerinin fiyatı yok: ürün maliyeti boş çıkar.', 'Malzemeler dosyasında Standart maliyet sütununu ya da Tedarik koşulları dosyasını doldurun.'),
  (120, 'fason', 'Fason fiyatları', NULLIF(s.fason_fiyatsiz, 0), false,
   'Dış tedarik adımlarının fiyatı çıkmıyor: ürün maliyeti boş kalır.', 'Operasyon kartına fason fiyatı (adet ya da kg) girin.'),
  (130, 'kritik', 'Kritik veri bulguları', NULLIF(s.kritik, 0), false,
   'Açık kritik bulgu var: planlama sonucu eksik ya da yanlış olabilir.', 'Veri kalitesi ekranında kritik bulguları kapatın.'),
  (140, 'yonetici', 'Tam yetkili kullanıcı', CASE WHEN s.yonetici = 0 THEN 1 END, false,
   'Tam yetkili aktif kullanıcı yok (sunucu kurulumunda gerekir; tarayıcı kipinde yetki denetimi yoktur).', 'Kullanıcılar ekranından yönetici rolü verin.'),
  (150, 'durus_nedeni', 'Duruş nedenleri', CASE WHEN s.durus_nedeni = 0 THEN 1 END, false,
   'Aktif duruş nedeni yok: sahada duruş bildirilemez, kayıp süre görünmez ve OEE kullanılabilirliği olduğundan iyi çıkar.', 'Duruş ve problem ekranında "Önerilen listeyi ekle" ile başlayın.'),
  (160, 'operator_kaynak', 'Operatör hesabı bağı', NULLIF(s.kaynaksiz_operator, 0), false,
   'Operatör hesabı bir kaynağa (operatör/makine kartı) bağlı değil: sahada "Ben" seçimi boş kalır, kayıt kimseye yazılmaz, operatör verimliliği ve vardiya raporu boş çıkar.', 'Kullanıcılar ekranında "Saha kaynağı" sütunundan hesabı kaynağa bağlayın.'),
  (170, 'varsayim', 'Tahmini değerler', NULLIF(s.varsayim, 0), false,
   'Bu kadar değer gerçek veri değil tahmin: maliyet, kapasite ve teslim tarihleri gerçek değerler girilince değişir. Kurulumu tahminle açmak geçerlidir; yalnız hangi sonucun neye dayandığı bilinsin.', 'Veri kalitesi ekranının Tahmini değerler bölümünde listelenir; hesap izinde "tahmini" rozetiyle görünür.')
) AS x(sira, konu, baslik, sayi, eksik_mi, aciklama, cozum);

COMMENT ON VIEW sistem.kurulum_kontrol_v IS 'Firma kullanima hazir mi: eksik (akis calismaz) / uyari (sonuc eksik ya da tahmine dayali) / tamam (0059, saha 0060, tahmini deger 0061).';
GRANT SELECT ON sistem.kurulum_kontrol_v TO authenticated;
`,yi=`-- 0062 · GERI AL: STOGU EKSIYE DUSUREN GERI ALMA DURDURULUR
--
-- Olcum (19 Eyl 2026, demo veri): mal kabul -> malzeme uretimde tuketildi -> mal kabul islemi geri alindi.
-- 0016'dan beri stok hareketi ters kayitla dengeleniyor ama sonucun ne oldugu kontrol edilmiyordu: stok
-- sessizce -19,32'ye dustu, hicbir hata cikmadi. Ileri yonde koruma var (cikis yazilmadan once "stok yeterli
-- mi"), geri alma tarafinda hic yoktu; SQL'de negatif stok kontrolu hicbir yerde yoktu.
--
-- Bundan sonra: ters kayit yazilan her (kalem, depo, lot) bakiyesi dongu sonunda kontrol edilir, eksiye
-- dusen varsa islem Turkce mesajla durur. p_zorla ile yine yapilabilir (canlida temizlik icin bilincli karar).
-- Kontrol yalniz geri alma yolunda: her stok hareketine tetikleyici koymak butun yazmalari yavaslatirdi,
-- acik olan yer burasiydi. Govde 0031'in gövdesidir (0016 + 0021 + 0031 birikimi korunur).

SELECT sistem.baglam_kur('kurulum', NULL, '0062_geri_al_negatif_stok', 'geri al: negatif stok korumasi');

CREATE OR REPLACE FUNCTION sistem.islem_geri_al(p_grup uuid, p_gerekce text DEFAULT NULL, p_zorla boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql
-- 0036: arama yolu sabit (SECURITY INVOKER -> ''); CREATE OR REPLACE bunu dusurdugu icin burada tekrar veriliyor.
SET search_path = ''
AS $$
DECLARE
  o        sistem.olay%ROWTYPE;
  v_yeni_grup uuid;
  v_simdiki jsonb;
  v_sayi   int := 0;
  v_dokunulan uuid[] := '{}';   -- ters kayit yazilan stok hareketleri
  v_eksik  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sistem.olay WHERE islem_grubu = p_grup) THEN
    RAISE EXCEPTION 'Islem grubu bulunamadi: %', p_grup;
  END IF;

  v_yeni_grup := sistem.baglam_kur('geri_al', sistem.baglam('kullanici'), p_grup::text,
                                   COALESCE(p_gerekce, 'islem grubu geri alindi'));

  FOR o IN SELECT * FROM sistem.olay WHERE islem_grubu = p_grup ORDER BY id DESC LOOP
    EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %I::text = $1', o.varlik, o.anahtar_alan)
      INTO v_simdiki USING o.kayit_id;

    IF o.islem = 'ekle' THEN
      IF v_simdiki IS NULL THEN CONTINUE; END IF;
      IF o.varlik = 'cekirdek.stok_hareket' THEN
        -- Defter: silinmez, ters kayitla dengelenir.
        IF EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE ters_hareket_id = o.kayit_id::uuid) THEN
          RAISE EXCEPTION 'Geri alinamaz: stok hareketi % zaten ters kayitla duzeltilmis.', o.kayit_id;
        END IF;
        PERFORM cekirdek.stok_hareket_ters_kayit(o.kayit_id::uuid, 'geri alındı: işlem ' || p_grup::text);
        v_dokunulan := v_dokunulan || o.kayit_id::uuid;
      ELSIF o.varlik = 'cekirdek.lot' AND EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE lot_id = o.kayit_id::uuid) THEN
        -- Lot defterde geciyor (asil + ters kayit): silinmez, stoku 0 olarak kalir.
        NULL;
      ELSIF o.varlik = 'cekirdek.belge_satir' AND EXISTS (SELECT 1 FROM cekirdek.stok_hareket WHERE belge_satir_id = o.kayit_id::uuid) THEN
        -- 0031: ayni islemde acilan belge satiri defterde geciyor (asil + ters kayit): silinmez, net hareketi 0.
        NULL;
      ELSIF o.varlik = 'cekirdek.belge' AND EXISTS (
          SELECT 1 FROM cekirdek.stok_hareket h JOIN cekirdek.belge_satir s ON s.id = h.belge_satir_id WHERE s.belge_id = o.kayit_id::uuid) THEN
        NULL;
      ELSE
        EXECUTE format('DELETE FROM %s WHERE %I::text = $1', o.varlik, o.anahtar_alan) USING o.kayit_id;
      END IF;

    ELSIF o.islem = 'sil' THEN
      IF v_simdiki IS NOT NULL AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% silindikten sonra yeniden olusturulmus.', o.varlik, o.kayit_id;
      END IF;
      EXECUTE format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, $1)', o.varlik) USING o.eski;

    ELSE -- degistir
      IF v_simdiki IS NULL THEN
        RAISE EXCEPTION 'Geri alinamaz: %/% artik yok.', o.varlik, o.kayit_id;
      END IF;
      IF (v_simdiki -> o.alan) IS DISTINCT FROM o.yeni AND NOT p_zorla THEN
        RAISE EXCEPTION 'Geri alinamaz: %/%.% bu islemden sonra degistirilmis (simdi %, islem %).',
          o.varlik, o.kayit_id, o.alan, v_simdiki -> o.alan, o.yeni;
      END IF;
      EXECUTE format(
        'UPDATE %1$s SET %2$I = (jsonb_populate_record(NULL::%1$s, $1)).%2$I WHERE %3$I::text = $2',
        o.varlik, o.alan, o.anahtar_alan)
        USING jsonb_build_object(o.alan, o.eski), o.kayit_id;
    END IF;
    v_sayi := v_sayi + 1;
  END LOOP;

  -- 0062: geri alinan hareketler baska islemlerde kullanilmis olabilir. Ters kayitlardan sonra dokunulan her
  -- (kalem, depo, lot) bakiyesine bakilir; biri eksiye dusuyorsa hicbir sey yapilmaz (her sey geri sarilir).
  -- Yuvarlama payi (5e-7, cekirdek cikis yuvarlamasiyla ayni) kadar eksi, eksi sayilmaz.
  IF array_length(v_dokunulan, 1) IS NOT NULL AND NOT p_zorla THEN
    SELECT string_agg(format('%s: %s%s', x.kod, round(x.bakiye, 6),
                             CASE WHEN x.lot_no IS NOT NULL THEN ' (lot ' || x.lot_no || ')' ELSE '' END), ' · ' ORDER BY x.kod)
      INTO v_eksik
    FROM (
      SELECT k.kod, l.lot_no, sum(h2.miktar) AS bakiye
      FROM cekirdek.stok_hareket h
      JOIN cekirdek.stok_hareket h2
        ON h2.kalem_id = h.kalem_id AND h2.depo_id = h.depo_id AND h2.lot_id IS NOT DISTINCT FROM h.lot_id
      JOIN cekirdek.kalem k ON k.id = h.kalem_id
      LEFT JOIN cekirdek.lot l ON l.id = h.lot_id
      WHERE h.id = ANY (v_dokunulan)
      GROUP BY h.kalem_id, h.depo_id, h.lot_id, k.kod, l.lot_no
      HAVING sum(h2.miktar) < -5e-7
    ) x;

    IF v_eksik IS NOT NULL THEN
      RAISE EXCEPTION 'Geri alınamaz: stok eksiye düşerdi — %. Bu malzemeyi kullanan işlemleri önce geri alın (zorunluysa zorla geri alma).', v_eksik
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN v_yeni_grup;
END $$;
`,Li=`-- 0063 · BIRIM DONUSUMUNDE YOL SIRASI SABIT
--
-- cekirdek.miktar_cevir, kaleme ozel donusumleri ORDER BY'siz bir UNION ALL ile geziyor ve ISE YARAYAN ILK
-- yolu doner. Bir kalemde ayni cifte giden IKI yol varsa (ornek: 1 boy = 6 m ve 1 boy = 5800 mm) hangisinin
-- secildigi satir sirasina baglidir; satir sirasi Postgres'te garanti degildir (plan degisir, VACUUM sonrasi
-- fiziksel sira degisir). Ayni veride ekran (TS ikizi, packages/cekirdek/src/birim.ts) baska, veritabani
-- baska sayi uretebilirdi — ikiligin sessiz ayrisma olmamasi ilkesi tam da bunu yasaklar.
--
-- Bugun Ozler'de kaleme ozel donusum yok (kalem_birim bos), yani canlida bir sayi degismiyor; bu, ileride
-- bir firma iki yol tanimladiginda ayrismayi onleyen koruma. Sira iki tarafta da ayni: once ILERI yonlu
-- donusumler (kaynak_birim, hedef_birim) alfabetik, sonra TERS yonlu olanlar ayni siraya gore.

SELECT sistem.baglam_kur('kurulum', NULL, '0063_birim_yol_sirasi', 'birim donusumu: yol sirasi sabit');

CREATE OR REPLACE FUNCTION cekirdek.miktar_cevir(p_kalem_id uuid, p_miktar numeric, p_kaynak text, p_hedef text)
RETURNS numeric LANGUAGE plpgsql STABLE
-- 0036: arama yolu sabit (SECURITY INVOKER -> ''); CREATE OR REPLACE bunu dusurdugu icin tekrar veriliyor.
SET search_path = ''
AS $$
DECLARE
  k cekirdek.birim; h cekirdek.birim;
  r record;
  v_ara numeric;
BEGIN
  IF p_miktar IS NULL THEN RETURN NULL; END IF;
  IF p_kaynak = p_hedef THEN RETURN p_miktar; END IF;
  SELECT * INTO k FROM cekirdek.birim WHERE kod = p_kaynak;
  SELECT * INTO h FROM cekirdek.birim WHERE kod = p_hedef;
  IF k.kod IS NULL OR h.kod IS NULL THEN
    RAISE EXCEPTION 'Birim tanimsiz: % veya %', p_kaynak, p_hedef USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF k.boyut = h.boyut AND k.temel_carpan IS NOT NULL AND h.temel_carpan IS NOT NULL THEN
    RETURN p_miktar * k.temel_carpan / h.temel_carpan;
  END IF;

  -- Kaleme ozel: once ileri yon, sonra ters yon; her ikisi de (kaynak, hedef) alfabetik. TS ikiziyle ayni sira.
  FOR r IN
    SELECT kk, hk, carpan FROM (
      SELECT kb.kaynak_birim AS kk, kb.hedef_birim AS hk, kb.hedef_miktar AS carpan, 0 AS yon
      FROM cekirdek.kalem_birim kb WHERE kb.kalem_id = p_kalem_id
      UNION ALL
      SELECT kb.hedef_birim, kb.kaynak_birim, 1 / kb.hedef_miktar, 1
      FROM cekirdek.kalem_birim kb WHERE kb.kalem_id = p_kalem_id
    ) y ORDER BY y.yon, y.kk, y.hk
  LOOP
    BEGIN
      v_ara := cekirdek.miktar_cevir_sabit(p_miktar, p_kaynak, r.kk);
      IF v_ara IS NULL THEN CONTINUE; END IF;
      v_ara := v_ara * r.carpan;
      v_ara := cekirdek.miktar_cevir_sabit(v_ara, r.hk, p_hedef);
      IF v_ara IS NOT NULL THEN RETURN v_ara; END IF;
    END;
  END LOOP;

  RAISE EXCEPTION 'Birim donusumu yok: % -> % (kalem %). Kalem kartina donusum eklenmeli.', p_kaynak, p_hedef, p_kalem_id
    USING ERRCODE = 'data_exception';
END $$;
`,Ti=`-- FIRMA PAKETI · DEMO A.S.
--
-- Bos kurulumun ustune ornek bir firma: ekran iskeletini gercek hacimde (≈3.000 kalem) denemek,
-- canli dedektor rozetlerini ve hesap izini gostermek icin. Veri DETERMINISTIKTIR (random yok):
-- her kurulumda ayni kodlar, ayni bulgular. Testler bu sayilara dayanir.
--
-- Bilerek konmus kusurlar (ekranda rozet olarak gorunmeli):
--   * 12 kalem eski kod biciminde                    -> D-KALEM-KOD-SABLONU (uyari)
--   * her 10. mamul, her 25. yari mamul agacsiz      -> D-URETILEN-AGACSIZ (uyari)
--   * 5, 55, 105... numarali mamulde m -> kg satiri  -> D-AGAC-BIRIM-DONUSUMU (kritik)
--   * her 97. sacta kalinlik bos                     -> teorik agirlik hesabi "eksik girdi"

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo', 'Demo A.S. firma paketi');

INSERT INTO sistem.firma (ad, kisa_ad) VALUES ('Demo Üretim A.Ş.', 'Demo');

-- KOD SABLONU -------------------------------------------------------------------
INSERT INTO sistem.kural (kod, ad, tur, varlik, durum, kaynak, aciklama, tanim, ornekler) VALUES
('K-KOD-SABLON', 'Demo kod şablonu', 'kod_sablonu', 'cekirdek.kalem', 'aktif', 'Demo kurulumu',
 'İki harfli tür öneki (HM hammadde, YM yarı mamul, MM mamul, SR sarf), tire, beş hane sıra numarası.',
 '{"desenler":[{"ad":"standart","desen":"^(HM|YM|MM|SR)-([0-9]{5})$","gruplar":["onek","sira"]}]}',
 '[
   {"girdi":{"kod":"HM-00012"}, "beklenen":{"sablon":"standart","onek":"HM","sira":"00012"}, "not":"hammadde"},
   {"girdi":{"kod":"MM-00700"}, "beklenen":{"sablon":"standart","onek":"MM","sira":"00700"}, "not":"mamul"},
   {"girdi":{"kod":"XX-00012"}, "beklenen":null, "not":"tanımsız önek"},
   {"girdi":{"kod":"HM-12"},    "beklenen":null, "not":"eksik hane"}
 ]');

-- EK ALANLAR --------------------------------------------------------------------
-- Formul alani: saklanmaz, ekranda cekirdek formul motoruyla hesap iziyle gosterilir.
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, etiket_ceviri, grup, sira, tip, depolama, gorunur, birim, min_deger, formul, aciklama) VALUES
  ('cekirdek.kalem','yogunluk','Yoğunluk','{"en":"Density"}','Ölçü ve geometri',85,'sayi','ozellik',true,'g/cm3',0,NULL,NULL),
  ('cekirdek.kalem','teorik_agirlik','Teorik ağırlık','{"en":"Theoretical weight"}','Ölçü ve geometri',90,'formul','ozellik',true,'kg',NULL,
   'en * boy * kalinlik * yogunluk / 1000000', 'mm × mm × mm × g/cm³ → kg. Saklanmaz, her açılışta hesaplanır.');

-- DEPO ve IS MERKEZI ------------------------------------------------------------
INSERT INTO cekirdek.depo (kod, ad) VALUES ('ANA', 'Ana depo'), ('SEVK', 'Sevkiyat alanı');

INSERT INTO cekirdek.is_merkezi (kod, ad, saat_maliyeti, gunluk_kapasite_saat, paralel_kaynak, ozellik) VALUES
  ('KES', 'Kesim', 850, 16, 2, '{"bolum":"İmalat"}'),
  ('BUK', 'Büküm', 720, 8, 1, '{"bolum":"İmalat"}'),
  ('KYN', 'Kaynak', 900, 16, 4, '{"bolum":"İmalat"}'),
  ('MON', 'Montaj', 600, 8, 6, '{"bolum":"Montaj"}');

-- KALEMLER ----------------------------------------------------------------------
-- Hammadde: sac levha (1.200)
INSERT INTO cekirdek.kalem (kod, ad, tip, stok_birimi, tedarik_suresi_gun, min_stok, varsayilan_depo_id, ozellik)
SELECT 'HM-' || lpad(i::text, 5, '0'),
       format('Sac levha %s×%s×%s %s', en, boy, kal, cins),
       'hammadde', 'kg', 7 + i % 14, (i % 5) * 100,
       (SELECT id FROM cekirdek.depo WHERE kod = 'ANA'),
       jsonb_strip_nulls(jsonb_build_object(
         'en', en, 'boy', boy, 'kalinlik', CASE WHEN i % 97 = 0 THEN NULL ELSE kal END,
         'yogunluk', CASE cins WHEN 'AlMg3' THEN 2.66 WHEN '304' THEN 7.93 ELSE 7.85 END,
         'urun_grubu', 'Sac', 'malzeme_cinsi', cins))
FROM generate_series(1, 1200) i,
     LATERAL (SELECT (ARRAY[1000, 1250, 1500, 2000])[1 + i % 4] AS en,
                     (ARRAY[2000, 2500, 3000, 4000, 6000])[1 + i % 5] AS boy,
                     (ARRAY[0.8, 1, 1.5, 2, 3, 4, 5, 6, 8, 10])[1 + i % 10] AS kal,
                     (ARRAY['DKP', 'S235', 'S355', 'AlMg3', '304', 'HRP'])[1 + i % 6] AS cins) x;

-- Yari mamul (800)
INSERT INTO cekirdek.kalem (kod, ad, tip, stok_birimi, varsayilan_depo_id, ozellik)
SELECT 'YM-' || lpad(i::text, 5, '0'),
       format('%s %s', (ARRAY['Kesim parçası', 'Bükümlü braket', 'Kaynaklı gövde', 'Delikli lama', 'Flanş'])[1 + i % 5], i),
       'yari_mamul', 'adet',
       (SELECT id FROM cekirdek.depo WHERE kod = 'ANA'),
       jsonb_strip_nulls(jsonb_build_object(
         'urun_grubu', (ARRAY['Kesim', 'Büküm', 'Kaynak', 'Kesim', 'Talaşlı'])[1 + i % 5],
         'uretim_notu', CASE WHEN i % 5 = 0 THEN
           'Kesimden sonra çapak alınır. Büküm öncesi yüzey kontrolü yapılır; çizik varsa parça ayrılır ve kalite kaydı açılır. Ölçü toleransı ±0,5 mm.'
         END))
FROM generate_series(1, 800) i;

-- Mamul (700)
INSERT INTO cekirdek.kalem (kod, ad, tip, stok_birimi, varsayilan_depo_id, ozellik)
SELECT 'MM-' || lpad(i::text, 5, '0'),
       format('%s %s', aile, (ARRAY['S', 'M', 'L', 'XL'])[1 + i % 4]) || ' · model ' || i,
       'mamul', 'adet',
       (SELECT id FROM cekirdek.depo WHERE kod = 'SEVK'),
       jsonb_build_object('urun_ailesi', aile, 'urun_grubu', 'Mamul', 'revizyon', 'R' || (1 + i % 3))
FROM generate_series(1, 700) i,
     LATERAL (SELECT (ARRAY['Raf sistemi', 'Depo arabası', 'Paletli kafes', 'Makine şasesi', 'Merdiven'])[1 + i % 5] AS aile) x;

-- Sarf (300)
INSERT INTO cekirdek.kalem (kod, ad, tip, stok_birimi, planlama_yontemi, min_stok, ozellik)
SELECT 'SR-' || lpad(i::text, 5, '0'),
       (ARRAY['Kaynak teli 1,0 mm', 'Kesme diski 125', 'Tiner', 'Koruyucu eldiven', 'Zımpara P120'])[1 + i % 5] || ' #' || i,
       'sarf', (ARRAY['kg', 'adet', 'lt', 'adet', 'adet'])[1 + i % 5], 'min_max', 10 + i % 40,
       '{"urun_grubu":"Sarf"}'
FROM generate_series(1, 300) i;

-- Eski kod bicimi (12): sablon dedektoru yakalar
INSERT INTO cekirdek.kalem (kod, ad, tip, stok_birimi, ozellik)
SELECT 'ESKI.' || i, 'Eski sistemden gelen kalem ' || i, 'hammadde', 'adet', '{"urun_grubu":"Aktarım"}'
FROM generate_series(1, 12) i;

-- URUN AGACLARI -----------------------------------------------------------------
-- Yari mamul: her 25.si haric, 1 sac satiri (kg)
INSERT INTO cekirdek.urun_agaci (kalem_id, surum, durum)
SELECT k.id, 1, 'aktif' FROM cekirdek.kalem k
WHERE k.tip = 'yari_mamul' AND substr(k.kod, 4)::int % 25 <> 0;

INSERT INTO cekirdek.urun_agaci_satir (agac_id, sira, bilesen_kalem_id, miktar, birim)
SELECT a.id, 1, h.id, 1 + (n % 9) * 0.75, 'kg'
FROM cekirdek.urun_agaci a
JOIN cekirdek.kalem k ON k.id = a.kalem_id AND k.tip = 'yari_mamul'
CROSS JOIN LATERAL (SELECT substr(k.kod, 4)::int AS n) x
JOIN cekirdek.kalem h ON h.kod = 'HM-' || lpad((1 + n % 1200)::text, 5, '0');

-- Mamul: her 10.u haric, 2 yari mamul + 1 sac
INSERT INTO cekirdek.urun_agaci (kalem_id, surum, durum)
SELECT k.id, 1, 'aktif' FROM cekirdek.kalem k
WHERE k.tip = 'mamul' AND substr(k.kod, 4)::int % 10 <> 0;

INSERT INTO cekirdek.urun_agaci_satir (agac_id, sira, bilesen_kalem_id, miktar, birim)
SELECT a.id, s.sira, b.id, s.miktar, s.birim
FROM cekirdek.urun_agaci a
JOIN cekirdek.kalem k ON k.id = a.kalem_id AND k.tip = 'mamul'
CROSS JOIN LATERAL (SELECT substr(k.kod, 4)::int AS n) x
CROSS JOIN LATERAL (VALUES
  (1, 'YM-' || lpad((1 + n % 800)::text, 5, '0'), 1 + n % 4, 'adet'),
  (2, 'YM-' || lpad((1 + (n * 7) % 800)::text, 5, '0'), 2, 'adet'),
  -- 5, 55, 105...: sac metre ile yazilmis; kg stoklu kalemde m -> kg donusumu yok (bilerek)
  (3, 'HM-' || lpad((1 + (n * 3) % 1200)::text, 5, '0'), 4 + n % 6, CASE WHEN n % 50 = 5 THEN 'm' ELSE 'kg' END)
) s(sira, kod, miktar, birim)
JOIN cekirdek.kalem b ON b.kod = s.kod;

-- ACILIS STOKU ------------------------------------------------------------------
-- Stok tablo degil: acilis belgesi + hareket. Listede gorunen stok bu defterin toplamidir.
INSERT INTO cekirdek.belge (tur, no, tarih, durum, aciklama)
VALUES ('acilis', 'ACL-0001', DATE '2026-09-01', 'tamam', 'Demo açılış stoku');

INSERT INTO cekirdek.belge_satir (belge_id, sira, kalem_id, miktar, birim, durum)
SELECT b.id, row_number() OVER (ORDER BY k.kod), k.id, 250 + (substr(k.kod, 4)::int % 13) * 180, 'kg', 'tamam'
FROM cekirdek.kalem k, cekirdek.belge b
WHERE b.no = 'ACL-0001' AND k.tip = 'hammadde' AND k.kod LIKE 'HM-%' AND substr(k.kod, 4)::int % 3 <> 0;

INSERT INTO cekirdek.stok_hareket (zaman, kalem_id, depo_id, miktar, tur, belge_satir_id)
SELECT TIMESTAMPTZ '2026-09-01 08:00+03', s.kalem_id, d.id, s.miktar, 'acilis', s.id
FROM cekirdek.belge_satir s
JOIN cekirdek.belge b ON b.id = s.belge_id AND b.no = 'ACL-0001'
JOIN cekirdek.depo d ON d.kod = 'ANA';
`,ci=`-- FIRMA PAKETI · DEMO A.S. · ROTA VE KAPASITE
--
-- Operasyonlar, her yari mamul ve mamul icin aktif rota, bir resmi tatil. Deterministik (random yok).
-- Kapasite 0001'deki is merkezlerinden: KES 16 sa × 2 · BUK 8 sa × 1 · KYN 16 sa × 4 · MON 8 sa × 6.
-- Boya dis tedarik (fason): kapasiteye yazilmaz.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0002', 'Demo A.S. rota ve kapasite');

INSERT INTO cekirdek.operasyon (kod, ad, rol, varsayilan_is_merkezi_id)
SELECT o.kod, o.ad, o.rol, (SELECT id FROM cekirdek.is_merkezi WHERE kod = o.im)
FROM (VALUES
  ('KESIM',  'Lazer / testere kesim', 'kesim',         'KES'),
  ('BUKUM',  'Abkant büküm',          'sekillendirme', 'BUK'),
  ('KAYNAK', 'Kaynak',                'birlestirme',   'KYN'),
  ('MONTAJ', 'Montaj ve paketleme',   'montaj',        'MON'),
  ('BOYA',   'Toz boya (fason)',      'dis_tedarik',   NULL)
) o(kod, ad, rol, im);

-- Yari mamul: urun grubuna gore 1 ya da 2 adim
INSERT INTO cekirdek.rota (kalem_id, surum, durum)
SELECT id, 1, 'aktif' FROM cekirdek.kalem WHERE tip IN ('yari_mamul', 'mamul');

INSERT INTO cekirdek.rota_adim (rota_id, sira, operasyon_id, is_merkezi_id, hazirlik_dk, islem_dk, parti_buyuklugu)
SELECT r.id, a.sira, o.id, o.varsayilan_is_merkezi_id, a.hazirlik, a.islem, a.parti
FROM cekirdek.rota r
JOIN cekirdek.kalem k ON k.id = r.kalem_id AND k.tip = 'yari_mamul'
CROSS JOIN LATERAL (SELECT substr(k.kod, 4)::int AS n, k.ozellik->>'urun_grubu' AS grup) x
CROSS JOIN LATERAL (VALUES
  (1, 'KESIM', 15 + n % 4 * 5, 1.5 + n % 3 * 0.5, 50),
  (2, CASE grup WHEN 'Büküm' THEN 'BUKUM' WHEN 'Kaynak' THEN 'KAYNAK' END, 20, 2 + n % 5, NULL)
) a(sira, op, hazirlik, islem, parti)
JOIN cekirdek.operasyon o ON o.kod = a.op;

-- Mamul: montaj + fason boya
INSERT INTO cekirdek.rota_adim (rota_id, sira, operasyon_id, is_merkezi_id, hazirlik_dk, islem_dk, parti_buyuklugu)
SELECT r.id, a.sira, o.id, o.varsayilan_is_merkezi_id, a.hazirlik, a.islem, NULL
FROM cekirdek.rota r
JOIN cekirdek.kalem k ON k.id = r.kalem_id AND k.tip = 'mamul'
CROSS JOIN LATERAL (SELECT substr(k.kod, 4)::int AS n) x
CROSS JOIN LATERAL (VALUES (1, 'MONTAJ', 15, 8 + n % 6 * 2), (2, 'BOYA', 0, 30)) a(sira, op, hazirlik, islem)
JOIN cekirdek.operasyon o ON o.kod = a.op;

INSERT INTO cekirdek.takvim_gun (tarih, tur, aciklama) VALUES
  ('2026-10-29', 'tatil', 'Cumhuriyet Bayramı'),
  ('2026-10-28', 'yarim_gun', 'Cumhuriyet Bayramı arifesi');
`,gi=`-- FIRMA PAKETI · DEMO A.S. · FASON SURESI (sema 0018)
-- Boya fasoncusu isi 3 is gununde teslim eder (adet basina dakika maliyet icin kalir).
SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0003', 'Demo A.S. fason boya suresi');

UPDATE cekirdek.rota_adim a SET dis_tedarik_gun = 3
FROM cekirdek.operasyon o WHERE o.id = a.operasyon_id AND o.kod = 'BOYA';
`,Ri=`-- FIRMA PAKETI · DEMO A.S. · TEDARIKCILER VE TEDARIK KOSULLARI (sema 0019)
--
-- Uc tedarikci; sac ve sarf kalemlerine deterministik kosul. Sacin bir kismi iki tedarikciden alinir
-- (biri varsayilan). Sac tonla satilir: asgari 0,5 ton, 0,1 ton katlari.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0004', 'Demo A.S. tedarikciler');

INSERT INTO cekirdek.partner (kod, ad, roller, ozellik) VALUES
  ('T-001', 'Anadolu Sac Metal A.Ş.',  ARRAY['tedarikci'],             '{"il":"Kocaeli","para_birimi":"TRY","odeme_vadesi_gun":60}'),
  ('T-002', 'Ege Çelik Ticaret Ltd.',  ARRAY['tedarikci'],             '{"il":"İzmir","para_birimi":"TRY","odeme_vadesi_gun":30}'),
  ('T-003', 'Birlik Hırdavat',         ARRAY['tedarikci'],             '{"il":"Bursa","para_birimi":"TRY","odeme_vadesi_gun":15}'),
  ('M-001', 'Örnek Lojistik A.Ş.',     ARRAY['musteri'],               '{"il":"İstanbul","para_birimi":"TRY"}');

-- Sac: tek numarali T-001 (varsayilan, 7 gun), cift numarali T-002 (varsayilan, 10 gun);
-- her 3.'sunde digeri de ikinci kaynak (varsayilan degil, daha ucuz ama yavas).
INSERT INTO cekirdek.tedarik_kosulu (kalem_id, partner_id, birim, birim_fiyat, tedarik_suresi_gun, asgari_siparis, siparis_kati, varsayilan)
SELECT k.id, p.id, 'ton', 32000 + (n % 7) * 1500, CASE WHEN p.kod = 'T-001' THEN 7 ELSE 10 END, 0.5, 0.1, true
FROM cekirdek.kalem k
CROSS JOIN LATERAL (SELECT substr(k.kod, 4)::int AS n) x
JOIN cekirdek.partner p ON p.kod = CASE WHEN n % 2 = 1 THEN 'T-001' ELSE 'T-002' END
WHERE k.kod LIKE 'HM-%';

INSERT INTO cekirdek.tedarik_kosulu (kalem_id, partner_id, birim, birim_fiyat, tedarik_suresi_gun, asgari_siparis, siparis_kati, varsayilan)
SELECT k.id, p.id, 'ton', 30500 + (n % 7) * 1500, 21, 1, 0.5, false
FROM cekirdek.kalem k
CROSS JOIN LATERAL (SELECT substr(k.kod, 4)::int AS n) x
JOIN cekirdek.partner p ON p.kod = CASE WHEN n % 2 = 1 THEN 'T-002' ELSE 'T-001' END
WHERE k.kod LIKE 'HM-%' AND n % 3 = 0;

-- Sarf: T-003, kendi biriminde, 3 gun, 10'lu kat
INSERT INTO cekirdek.tedarik_kosulu (kalem_id, partner_id, birim, birim_fiyat, tedarik_suresi_gun, siparis_kati, varsayilan)
SELECT k.id, p.id, k.stok_birimi, 40 + (substr(k.kod, 4)::int % 9) * 15, 3, 10, true
FROM cekirdek.kalem k, cekirdek.partner p
WHERE k.kod LIKE 'SR-%' AND p.kod = 'T-003';
`,Ai=`-- FIRMA PAKETI · DEMO A.S. · FASON BOYA FIYATI (sema 0020)
SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0005', 'Demo A.S. fason boya fiyati');

UPDATE cekirdek.rota_adim a SET dis_tedarik_birim_fiyat = 18
FROM cekirdek.operasyon o WHERE o.id = a.operasyon_id AND o.kod = 'BOYA';
`,Oi=`-- DEMO A.S. · LOT ve KALITE
-- Litre birimli sarf malzemeler (boya, yag, tiner gibi) lot takipli, giris muayeneli, raf omru 365 gun, MRP ile.
-- Mal kabulde lot acilir ve karantinaya girer; Lot ve kalite ekraninda karar verilir.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo:0006', 'Demo: lot takipli sarf malzemeler');

UPDATE cekirdek.kalem
SET lot_takibi = true,
    planlama_yontemi = 'mrp',   -- siparise gore alinir (min-max oneri uretmez; lot akisi ekranda denenebilsin)
    ozellik = ozellik || '{"giris_muayenesi": true, "raf_omru_gun": 365}'
WHERE tip = 'sarf' AND stok_birimi = 'lt';
`,Ii=`-- DEMO A.S. · ACILIS STOKU DEGERI
-- Gercek firmada acilis stoku degeriyle gelir. Demoda acilis satirlarina varsayilan tedarikci fiyati
-- (tedarikci biriminden acilis satiri birimine cevrilerek) yazilir; boylece stok degeri ve gerceklesen
-- maliyet bos kalmaz. Varsayilan kosulu olmayan kalemin acilisi fiyatsiz kalir (bilerek: "değeri bilinmiyor").

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo:0007', 'Demo: açılış stoku değeri');

UPDATE cekirdek.belge_satir s
SET birim_fiyat = round(t.birim_fiyat * cekirdek.miktar_cevir(s.kalem_id, 1, s.birim, t.birim), 4)
FROM cekirdek.belge b, cekirdek.tedarik_kosulu t
WHERE b.id = s.belge_id AND b.no = 'ACL-0001'
  AND t.kalem_id = s.kalem_id AND t.varsayilan AND t.aktif AND t.para_birimi = 'TRY' AND t.birim_fiyat IS NOT NULL;
`,bi=`-- FIRMA PAKETI · DEMO A.S. · DOVIZ KURU + GENEL GIDER + MALIYET DONEMI
--
-- Urunun maliyet tarafi (sema 0023-0027) demoda hic gorunmuyordu: kur tablosu bos, genel gider
-- orani yok, maliyet donemi yok. Demoyu acan kisi bu ozelliklerin VAR OLDUGUNU bile anlamiyordu.
--
--   Kurlar   : EUR ve USD, 2026 Eylul. Demo fiyatlarinin HICBIRI doviz DEGILDIR -> maliyet degismez.
--              Kullanici EUR satis siparisi acip karliligi kuruyla gorebilir (Siparisler ekrani).
--   Genel gider: her is merkezine saat maliyetinin %20'si. Urun maliyeti bu kadar ARTAR ve
--              Maliyet ekraninda AYRI SUTUN olarak gorunur (bkz. apps/uretim el hesabi).
--   Donem    : acik "2026-09" donemi; kullanici "Hesapla" deyip dondurmayi deneyebilir.
--
-- EL HESABI (maliyet testiyle ayni): genel giderle MM-00001 = 3.125,50 -> 3.574,50
--   YM-00002 990,75 (149,9167 genel gider) · YM-00008 542,50 (49,5833) · MM-00001 montaj genel gideri 50

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0008', 'Demo A.S. kur, genel gider, maliyet donemi');

-- Genel gider: saat maliyetinin %20'si (isinma, amortisman, bakim, ustabasi)
UPDATE cekirdek.is_merkezi SET genel_gider_saat = saat_maliyeti * 0.20 WHERE saat_maliyeti IS NOT NULL;

-- Doviz kurlari (TCMB doviz alis, ornek degerler). Firma para birimi TRY: tabloya yazilmaz.
INSERT INTO cekirdek.kur (para_birimi, tarih, kur, tur, kaynak) VALUES
  ('EUR', '2026-09-01', 46.80, 'alis', 'TCMB'),
  ('EUR', '2026-09-07', 47.05, 'alis', 'TCMB'),
  ('EUR', '2026-09-14', 47.20, 'alis', 'TCMB'),
  ('EUR', '2026-09-14', 47.55, 'satis', 'TCMB'),
  ('USD', '2026-09-01', 40.60, 'alis', 'TCMB'),
  ('USD', '2026-09-07', 40.85, 'alis', 'TCMB'),
  ('USD', '2026-09-14', 41.00, 'alis', 'TCMB');

-- Acik maliyet donemi: ekranda "Hesapla" ve "Dondur" denenebilsin.
INSERT INTO cekirdek.maliyet_donemi (kod, ad, baslangic, bitis, aciklama)
VALUES ('2026-09', 'Eylül 2026', '2026-09-01', '2026-09-30', 'Demo: Hesapla ile doldurun, Dondur ile kilitleyin.');
`,Si=`-- FIRMA PAKETI · DEMO A.S. · BILESENIN ISE GIRDIGI ADIM (fire hesabi, sema 0024)
--
-- Demo agaclarinin hicbir satirinda "adim sirasi" yoktu: her bilesen ilk adimda giriyordu ve fire
-- bildiriminin "o adima kadar giren malzeme" kurali demoda HIC gorunmuyordu.
--
-- Kaynak grubundaki yari mamullere (rota: 1 KESIM · 2 KAYNAK) KAYNAK TELI eklenir, adim sirasi 2:
--   * KESIM'de hurdaya cikan parca kaynak telini HARCAMAMISTIR -> fire yalniz saci duser.
--   * KAYNAK'ta hurdaya cikan parca ikisini de harcamistir.
-- Kaynak teli SR-00005 (demo 0001: "Kaynak teli 1,0 mm", kg; demo 0004: T-003, 115 TL/kg).
-- Acilis stoku (ACL-0002) fiyatiyla gelir: stok degeri ve gerceklesen maliyet bos kalmaz.
--
-- EL HESABI (maliyet testiyle ayni): YM-00002'ye 0,1 kg × 115 = 11,50 eklenir
--   YM-00002 990,75 -> 1.002,25 · MM-00001 (2 adet YM-00002) 3.574,50 -> 3.597,50

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0009', 'Demo A.S. kaynak teli ve adim sirasi');

-- Kaynak adimi olan yari mamullerin AKTIF agacina kaynak teli (adim 2)
INSERT INTO cekirdek.urun_agaci_satir (agac_id, sira, bilesen_kalem_id, miktar, birim, rota_adim_sira)
SELECT a.id, (SELECT max(s.sira) + 1 FROM cekirdek.urun_agaci_satir s WHERE s.agac_id = a.id), tel.id, 0.1, 'kg', 2
FROM cekirdek.urun_agaci a
JOIN cekirdek.kalem k ON k.id = a.kalem_id AND k.tip = 'yari_mamul'
JOIN cekirdek.kalem tel ON tel.kod = 'SR-00005'
WHERE a.durum = 'aktif'
  AND EXISTS (
    SELECT 1 FROM cekirdek.rota r
    JOIN cekirdek.rota_adim ra ON ra.rota_id = r.id AND ra.sira = 2
    JOIN cekirdek.operasyon o ON o.id = ra.operasyon_id AND o.kod = 'KAYNAK'
    WHERE r.kalem_id = k.id AND r.durum = 'aktif');

-- Saclar kesimde girer: bunu da ACIKCA yazalim (bos = ilk adim ile ayni ama demoda gorunsun)
UPDATE cekirdek.urun_agaci_satir s SET rota_adim_sira = 1
FROM cekirdek.urun_agaci a, cekirdek.kalem k, cekirdek.kalem b
WHERE s.agac_id = a.id AND a.durum = 'aktif' AND k.id = a.kalem_id AND k.tip = 'yari_mamul'
  AND b.id = s.bilesen_kalem_id AND b.kod LIKE 'HM-%';

-- Kaynak teli acilis stoku (fiyatiyla)
INSERT INTO cekirdek.belge (tur, no, tarih, durum, aciklama)
VALUES ('acilis', 'ACL-0002', DATE '2026-09-01', 'tamam', 'Demo açılış stoku: kaynak teli');

INSERT INTO cekirdek.belge_satir (belge_id, sira, kalem_id, miktar, birim, durum, birim_fiyat)
SELECT b.id, 1, k.id, 500, 'kg', 'tamam', 115
FROM cekirdek.belge b, cekirdek.kalem k WHERE b.no = 'ACL-0002' AND k.kod = 'SR-00005';

INSERT INTO cekirdek.stok_hareket (zaman, kalem_id, depo_id, miktar, tur, belge_satir_id)
SELECT TIMESTAMPTZ '2026-09-01 08:00+03', s.kalem_id, d.id, s.miktar, 'acilis', s.id
FROM cekirdek.belge_satir s
JOIN cekirdek.belge b ON b.id = s.belge_id AND b.no = 'ACL-0002'
JOIN cekirdek.depo d ON d.kod = 'ANA';
`,pi=`-- FIRMA PAKETI · DEMO A.S. · ORNEK TEKLIF VE ACIK SAYIM (sema 0031, 0032)
--
-- Teklif ve sayim demoda hic gorunmuyordu. Ikisi de STOK HAREKETI URETMEZ:
--   * teklif MRP'ye talep olarak girmez (belge_satir_kalan'da yok),
--   * acik (uygulanmamis) sayim yalniz tutanaktir.
-- Bu yuzden mevcut demo el hesaplari (MM-00001 maliyeti, akis testi hareket sayilari) DEGISMEZ.
--
--   TK-00001: M-001 icin MM-00001 5 adet × 4.500 TL (birim maliyet 3.597,50 -> ~%20 marj) ve
--             MM-00002 2 adet × 1.000 TL (bilerek zararli: ekranda kirmizi satir gorunsun). Gecerlilik 15.10.
--   SY-00001: ANA deposunda ilk uc stoklu sacin sayimi basladi; ikisine sayilan yazili (biri farkli),
--             biri sayilmadi. Kullanici "Sayimi uygula" ile farki gorebilir.
-- Ikinci depo (SEVK) 0001'de zaten var: Depo ekraninda transfer denenebilir.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0010', 'Demo A.S. ornek teklif ve acik sayim');

-- Ornek teklif
INSERT INTO cekirdek.belge (tur, no, tarih, partner_id, termin, durum, aciklama, para_birimi)
SELECT 'satis_teklifi', 'TK-00001', DATE '2026-09-15', p.id, DATE '2026-10-15', 'onayli', 'Demo teklifi', 'TRY'
FROM cekirdek.partner p WHERE p.kod = 'M-001';

INSERT INTO cekirdek.belge_satir (belge_id, sira, kalem_id, miktar, birim, birim_fiyat)
SELECT b.id, v.sira, k.id, v.miktar, 'adet', v.fiyat
FROM cekirdek.belge b
CROSS JOIN (VALUES (1, 'MM-00001', 5, 4500), (2, 'MM-00002', 2, 1000)) v(sira, kod, miktar, fiyat)
JOIN cekirdek.kalem k ON k.kod = v.kod
WHERE b.no = 'TK-00001';

-- Acik sayim: ANA deposunda stoklu ilk uc sac (kod sirasiyla)
INSERT INTO cekirdek.belge (tur, no, tarih, durum, aciklama, ozellik)
SELECT 'sayim', 'SY-00001', DATE '2026-09-16', 'devam', 'Demo: döngüsel sayım (ilk üç sac)', jsonb_build_object('depo_id', d.id::text)
FROM cekirdek.depo d WHERE d.kod = 'ANA';

INSERT INTO cekirdek.sayim_satir (belge_id, kalem_id, depo_id, lot_id, sistem_miktari, sayilan)
SELECT b.id, s.kalem_id, s.depo_id, s.lot_id, s.miktar,
       CASE s.sira WHEN 1 THEN s.miktar WHEN 2 THEN s.miktar - 12 ELSE NULL END
FROM cekirdek.belge b
CROSS JOIN LATERAL (
  SELECT d.kalem_id, d.depo_id, d.lot_id, d.miktar, row_number() OVER (ORDER BY k.kod) AS sira
  FROM cekirdek.stok_durum d
  JOIN cekirdek.kalem k ON k.id = d.kalem_id AND k.kod LIKE 'HM-%'
  JOIN cekirdek.depo dp ON dp.id = d.depo_id AND dp.kod = 'ANA'
  WHERE d.miktar > 0
  ORDER BY k.kod LIMIT 3
) s
WHERE b.no = 'SY-00001';
`,Ui=`-- FIRMA PAKETI · DEMO A.S. · SAHA: OPERATORLER VE DURUS NEDENLERI (sema 0022, 0037)
--
-- Saha ekraninda "Ben" secimi ve duruş girisi demoda bos kaliyordu: kaynak ve durus nedeni yoktu.
--   * Her is merkezine bir operator (saat maliyeti BOS: maliyet eskisi gibi is merkezinden gelir,
--     demo el hesaplari degismez).
--   * Durus nedenleri: bir imalat firmasinin tipik listesi; firma kendi listesini ekrandan degistirir.
-- Kayit (durus, operasyon suresi) EKLENMEZ: hareket ve maliyet testleri aynen kalir.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0011', 'Demo A.S. operatorler ve durus nedenleri');

INSERT INTO cekirdek.kaynak (kod, ad, tur, is_merkezi_id)
SELECT x.kod, x.ad, 'operator', m.id
FROM (VALUES ('OP-01', 'Ayşe (Kesim)', 'KES'), ('OP-02', 'Mehmet (Büküm)', 'BUK'), ('OP-03', 'Zeynep (Kaynak)', 'KYN'), ('OP-04', 'Ali (Montaj)', 'MON'))
  AS x(kod, ad, im)
JOIN cekirdek.is_merkezi m ON m.kod = x.im;

INSERT INTO cekirdek.durus_nedeni (kod, ad, tur, sira) VALUES
  ('ARIZA',    'Makine arızası',        'plansiz', 10),
  ('MALZEME',  'Malzeme bekleniyor',    'plansiz', 20),
  ('OPERATOR', 'Operatör yok',          'plansiz', 30),
  ('KALITE',   'Kalite sorunu / yeniden işleme', 'plansiz', 40),
  ('AYAR',     'Kalıp / ayar değişimi', 'planli',  50),
  ('BAKIM',    'Planlı bakım',          'planli',  60),
  ('MOLA',     'Mola / toplantı',       'planli',  70);
`,Ci=`-- FIRMA PAKETI · DEMO A.S. · KESIM PLANI VE ARTIK (sema 0038, 0040)
--
-- Kesim ekrani demoda bostu: kesim rollu adimi olan acik uretim emri yoktu. YENI KALEM EKLENMEZ, mevcutlar kullanilir:
--   * KES is merkezi: kesim payi 3 mm.
--   * YM-00003 (sac parca, agacta HM-00004 kesim adiminda): 400 × 900 mm.
--     YM-00005 (agacta HM-00006): 300 × 500 mm.
--   * HM-00004 (1000 × 6000, 3 mm, 7,93 kg/dm³): kenar payi 10, en kucuk artik 200;
--     kg <-> m² donusumu kalinlik × yogunluk = 3 × 7,93 = 23,79 kg/m² (artik girisi bu donusumu ister).
--     HM-00006 (1500 × 2500, 5 mm, 7,85): kenar payi 10, en kucuk artik 200; 5 × 7,85 = 39,25 kg/m².
--   * Acik uretim emirleri: UE-00001 YM-00003 × 6, UE-00002 YM-00005 × 12 (onayli, termin 30.09).
--   * Stokta bir artik levha: HM-00006 800 × 1200 mm, lot AR-00001, ANA deposu
--     (belge AR-00001, 0,96 m² × 39,25 = 37,68 kg). Kesim plani bunu yeni levhadan once kullanir.
--     Artik bilerek HM-00006'da: uctan uca akis testi (tests/akis.test.ts) HM-00004 stogunu el hesabiyla izler.
-- Etki (testler gerekceyle guncellendi): UE-00001/2 dolu -> akisin emirleri UE-00003'ten baslar; kapasite ve emir
-- maliyeti listelerinde bu iki emir de var; defterde bir 'sayim_farki' hareketi (artik girisi).

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:demo/0012', 'Demo A.S. kesim plani ve artik levha');

UPDATE cekirdek.is_merkezi SET ozellik = ozellik || '{"kesim_payi": 3}' WHERE kod = 'KES';

UPDATE cekirdek.kalem SET ozellik = ozellik || v.oz::jsonb
FROM (VALUES
  ('YM-00003', '{"en": 400, "boy": 900}'),
  ('YM-00005', '{"en": 300, "boy": 500}'),
  ('HM-00004', '{"uc_kirpma": 10, "min_artik": 200}'),
  ('HM-00006', '{"uc_kirpma": 10, "min_artik": 200}')
) v(kod, oz)
WHERE kalem.kod = v.kod;

INSERT INTO cekirdek.kalem_birim (kalem_id, kaynak_birim, hedef_birim, hedef_miktar)
SELECT k.id, 'm2', 'kg', v.kg FROM (VALUES ('HM-00004', 23.79), ('HM-00006', 39.25)) v(kod, kg)
JOIN cekirdek.kalem k ON k.kod = v.kod;

-- Acik uretim emirleri
INSERT INTO cekirdek.belge (tur, no, tarih, termin, durum, aciklama, para_birimi)
VALUES ('uretim_emri', 'UE-00001', DATE '2026-09-16', DATE '2026-09-30', 'onayli', 'Demo: sac parça kesimi', 'TRY'),
       ('uretim_emri', 'UE-00002', DATE '2026-09-16', DATE '2026-09-30', 'onayli', 'Demo: sac parça kesimi', 'TRY');

INSERT INTO cekirdek.belge_satir (belge_id, sira, kalem_id, miktar, birim, termin)
SELECT b.id, 1, k.id, v.miktar, 'adet', DATE '2026-09-30'
FROM (VALUES ('UE-00001', 'YM-00003', 6), ('UE-00002', 'YM-00005', 12)) v(no, kod, miktar)
JOIN cekirdek.belge b ON b.tur = 'uretim_emri' AND b.no = v.no
JOIN cekirdek.kalem k ON k.kod = v.kod;

-- Artik levha (veri/artik.ts artikEkle ile ayni kayit bicimi)
INSERT INTO cekirdek.belge (tur, no, tarih, durum, aciklama)
VALUES ('sayim', 'AR-00001', DATE '2026-09-16', 'tamam', 'Artık girişi: HM-00006 800 × 1200 mm × 1');

INSERT INTO cekirdek.belge_satir (belge_id, sira, kalem_id, miktar, birim, durum)
SELECT b.id, 1, k.id, 37.68, 'kg', 'tamam'
FROM cekirdek.belge b JOIN cekirdek.kalem k ON k.kod = 'HM-00006'
WHERE b.tur = 'sayim' AND b.no = 'AR-00001';

INSERT INTO cekirdek.lot (kalem_id, lot_no, ozellik)
SELECT id, 'AR-00001', '{"en": 800, "boy": 1200}' FROM cekirdek.kalem WHERE kod = 'HM-00006';

INSERT INTO cekirdek.stok_hareket (kalem_id, depo_id, lot_id, miktar, tur, belge_satir_id, aciklama)
SELECT k.id, d.id, l.id, 37.68, 'sayim_farki', s.id, 'artık girişi 800 × 1200 mm'
FROM cekirdek.kalem k
JOIN cekirdek.depo d ON d.kod = 'ANA'
JOIN cekirdek.lot l ON l.kalem_id = k.id AND l.lot_no = 'AR-00001'
JOIN cekirdek.belge b ON b.tur = 'sayim' AND b.no = 'AR-00001'
JOIN cekirdek.belge_satir s ON s.belge_id = b.id
WHERE k.kod = 'HM-00006';
`,Di=`-- FIRMA PAKETI · OZLER
--
-- Ozler'e ozgu olan HER SEY burada; cekirdek sema bunlari bilmez.
-- Yeni firmada bu dosyanin karsiligi kurulum sihirbazinda doldurulur.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:ozler', 'Ozler firma paketi');

INSERT INTO sistem.firma (ad, kisa_ad) VALUES ('Özler Kalıp ve İskele Sistemleri', 'Özler');

-- KOD SABLONU -------------------------------------------------------------------
-- Kaynak: UYS kural #49 (ilk 8 hane urun, son hane yuzey), #52 (YM onekleri uretim asamasi),
-- -L/-S eki varyanttir, koku ilk 9 hanedir (Serdar).
INSERT INTO sistem.kural (kod, ad, tur, varlik, durum, kaynak, aciklama, tanim, ornekler) VALUES
('K-KOD-SABLON', 'Özler kod şablonu', 'kod_sablonu', 'cekirdek.kalem', 'aktif', 'UYS kural #49, #52; Serdar',
 'Mamul: 8 hane ürün + 1 hane yüzey, isteğe bağlı -L/-S varyant eki. Yarı mamul: YMH/YMM/YMK öneki + sıra no.',
 '{"desenler":[
    {"ad":"mamul",      "desen":"^([0-9]{8})([0-9])(?:-([LS]))?$", "gruplar":["kok","varyant","ek"]},
    {"ad":"yari_mamul", "desen":"^(YM[HMK])([0-9]+)$",              "gruplar":["onek","kok"]}
  ]}',
 '[
   {"girdi":{"kod":"101902005"},   "beklenen":{"sablon":"mamul","kok":"10190200","varyant":"5","ek":null}, "not":"düz mamul"},
   {"girdi":{"kod":"101902005-L"}, "beklenen":{"sablon":"mamul","kok":"10190200","varyant":"5","ek":"L"},  "not":"-L varyant eki"},
   {"girdi":{"kod":"YMH102755"},   "beklenen":{"sablon":"yari_mamul","onek":"YMH","kok":"102755"},        "not":"yarı mamul"},
   {"girdi":{"kod":"10190200"},    "beklenen":null, "not":"8 hane: şablona uymaz"},
   {"girdi":{"kod":"101902005-X"}, "beklenen":null, "not":"tanımsız ek"}
 ]');

-- KARDES KURALI -----------------------------------------------------------------
-- Serdar: "sonu 2,4,5,6 kardes". Eski UYS'de 36 kopyasi vardi; burada TEK satir.
-- (Ayri INSERT: kapi, ornekleri calistirirken kod sablonunu tablodan okur.)
INSERT INTO sistem.kural (kod, ad, tur, varlik, durum, kaynak, aciklama, tanim, ornekler) VALUES
('K-KOD-KARDES', 'Özler yüzey kardeşi', 'kardes', 'cekirdek.kalem', 'aktif', 'Serdar',
 'Aynı 8 haneli köke sahip, son hanesi 2, 4, 5 veya 6 olan ve son haneleri farklı iki mamul kodu kardeştir (aynı ürünün farklı yüzey hali).',
 '{"kod_sablonu":"K-KOD-SABLON","ayni":["kok"],"ayirt":"varyant","gecerli":["2","4","5","6"]}',
 '[
   {"girdi":{"a":"101902002","b":"101902005"}, "beklenen":true,  "not":"aynı kök, 2 ve 5"},
   {"girdi":{"a":"101902004","b":"101902006"}, "beklenen":true,  "not":"aynı kök, 4 ve 6"},
   {"girdi":{"a":"101902002","b":"101902003"}, "beklenen":false, "not":"3 kardeş eki değil"},
   {"girdi":{"a":"101902002","b":"101903002"}, "beklenen":false, "not":"kök farklı"},
   {"girdi":{"a":"101902002","b":"101902002"}, "beklenen":false, "not":"kendisi kardeşi değil"},
   {"girdi":{"a":"YMH102755","b":"101902005"}, "beklenen":false, "not":"yarı mamulün varyant hanesi yok"}
 ]');

-- OZLER'E OZGU ALANLAR (metal isleme) ----------------------------------------------
INSERT INTO sistem.alan_tanim (varlik, alan_kodu, etiket, grup, sira, tip, depolama, gorunur, birim, min_deger, aciklama) VALUES
  ('cekirdek.kalem','kg_metre','kg/m','Birim',30,'sayi','ozellik',true,'kg',0,'Profil ve boruda metre ağırlığı.'),
  ('cekirdek.kalem','delik_adet','Delik adedi','Ölçü ve geometri',90,'tamsayi','ozellik',true,NULL,0,NULL),
  ('cekirdek.kalem','delik_cap','Delik çapı','Ölçü ve geometri',91,'sayi','ozellik',true,'mm',0,NULL),
  ('cekirdek.kalem','bukum_adet','Büküm adedi','Ölçü ve geometri',92,'tamsayi','ozellik',true,NULL,0,NULL),
  ('cekirdek.kalem','acili_kesim','Açılı kesim','Ölçü ve geometri',93,'evet_hayir','ozellik',true,NULL,NULL,NULL);

-- Ozler'de acik olan cekirdek alanlar
UPDATE sistem.alan_tanim SET gorunur = true
WHERE varlik = 'cekirdek.kalem' AND alan_kodu IN ('cap','ic_cap','yuzey_alani','teknik_resim');
`,zi=`-- FIRMA PAKETI · OZLER · KOD SABLONU YALNIZ URETILEN KALEMLER ICIN (sema 0045)
--
-- UYS kural #49 (mamul: 8 hane urun + 1 hane yuzey) ve #52 (yari mamul: YMH/YMM/YMK oneki) yalniz uretilen
-- kalemleri tarif eder. Satin alinan hammadde ve sarf kodlari (H..., T..., S..., Y..., ZZ..., SARF...) tedarikci
-- ya da eski sistem kodudur; Ozler icin bir kod kurali yoktur. Pilotta 795 sablon bulgusunun ~600'u bunlardi.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:ozler/0002', 'Ozler kod sablonu kapsami: mamul ve yari mamul');

UPDATE sistem.kural SET tanim = tanim || '{"tipler":["mamul","yari_mamul"]}'::jsonb
WHERE kod = 'K-KOD-SABLON';
`,vi=`-- FIRMA PAKETI · OZLER · MAMUL KODU DOGRULANMAZ, YALNIZ AYRISTIRILIR (5b karari, 17 Eyl)
--
-- Ozler'in iki mamul kod sistemi var: tamamen sayisal 9 hane (8 hane urun + 1 hane yuzey, UYS kural #49) ve harf
-- iceren aile kodlari (SMX Slabmax, 140SD/140SM, RAP, GBM...). Harfli kodlar mesrudur: aktif kart, aktif recete.
-- Kod sablonu bu firmada DOGRULAMA degil, OPSIYONEL AYRISTIRICIDIR: desene uyan koddan kok/yuzey cikarilir
-- (sistem.kod_coz degismez), uymayan kod gecerli bir koktur (kardesi ve yuzey hanesi yok) — bulgu uretilmez.
-- Yari mamul oneki (YMH/YMM/YMK, kural #52) denetlenmeye devam eder.

SELECT sistem.baglam_kur('kurulum', NULL, 'firma:ozler/0003', 'Ozler mamul kodu dogrulanmaz, yalniz ayristirilir');

UPDATE sistem.kural SET tanim = jsonb_set(tanim, '{tipler}', '["yari_mamul"]'::jsonb)
WHERE kod = 'K-KOD-SABLON';
`;function Fi(i){return i.replace(/\r\n/g,`
`)}const fi=/^(\d{4})_[a-z0-9_]+\.sql$/;async function Hi(i){const{rows:n}=await i.query("SELECT to_regclass('sistem.sema_surum') IS NOT NULL AS var");if(!n[0].var)return new Map;const a=await i.query("SELECT surum, checksum FROM sistem.sema_surum");return new Map(a.rows.map(r=>[r.surum,r.checksum]))}async function t(i,n){const a={uygulanan:[],atlanan:[]},r=await Hi(i);for(const e of n){const l=r.get(e.surum);if(l){if(l!==e.checksum)throw new Error(`Sema surumu ${e.surum} uygulandiktan sonra DEGISTIRILMIS (checksum farkli). Uygulanmis migration yeniden yazilmaz; degisikligi yeni bir dosyayla yapin.`);a.atlanan.push(e.surum);continue}await i.exec("BEGIN");try{await i.exec(e.icerik),await i.query("INSERT INTO sistem.sema_surum (surum, checksum) VALUES ($1, $2)",[e.surum,e.checksum]),await i.exec("COMMIT")}catch(k){throw await i.exec("ROLLBACK"),k.message=`${e.surum} uygulanamadi: ${k.message}`,k}a.uygulanan.push(e.surum)}return a}const Mi=Object.assign({"../../../../packages/sema/migrations/0001_sistem_temel.sql":d,"../../../../packages/sema/migrations/0002_olay_defteri.sql":m,"../../../../packages/sema/migrations/0003_kural_sozlugu.sql":o,"../../../../packages/sema/migrations/0004_alan_katalogu.sql":u,"../../../../packages/sema/migrations/0005_cekirdek_varliklar.sql":_,"../../../../packages/sema/migrations/0006_gorunum_tema.sql":N,"../../../../packages/sema/migrations/0007_tohum.sql":y,"../../../../packages/sema/migrations/0008_canli_dedektor.sql":L,"../../../../packages/sema/migrations/0009_etki_analizi.sql":T,"../../../../packages/sema/migrations/0010_olay_defteri_yetki.sql":c,"../../../../packages/sema/migrations/0011_koyu_tema_cizgi_kontrasti.sql":g,"../../../../packages/sema/migrations/0012_katalog_zorunlu_kolonlar.sql":R,"../../../../packages/sema/migrations/0013_dedektor_indeks_kosulu.sql":A,"../../../../packages/sema/migrations/0014_urun_agaci_baglam.sql":O,"../../../../packages/sema/migrations/0015_emir_baglami_ve_satir_kalani.sql":I,"../../../../packages/sema/migrations/0016_geri_al_defter_ters_kayit.sql":b,"../../../../packages/sema/migrations/0017_operasyon_katalogu.sql":S,"../../../../packages/sema/migrations/0018_rota_adim_fason_gun.sql":p,"../../../../packages/sema/migrations/0019_tedarik_kosulu.sql":U,"../../../../packages/sema/migrations/0020_rota_adim_fason_fiyat.sql":C,"../../../../packages/sema/migrations/0021_lot_kalite_izlenebilirlik.sql":D,"../../../../packages/sema/migrations/0022_operasyon_kaydi.sql":z,"../../../../packages/sema/migrations/0023_kur.sql":v,"../../../../packages/sema/migrations/0024_fire_malzeme_cikisi.sql":F,"../../../../packages/sema/migrations/0025_genel_gider.sql":f,"../../../../packages/sema/migrations/0026_maliyet_donemi.sql":H,"../../../../packages/sema/migrations/0027_muayene_suresi.sql":M,"../../../../packages/sema/migrations/0028_yeni_alan_dedektorleri.sql":h,"../../../../packages/sema/migrations/0029_acik_kayit_kapali_emir.sql":K,"../../../../packages/sema/migrations/0030_donem_maliyeti_urune_ozel.sql":W,"../../../../packages/sema/migrations/0031_stok_sayimi.sql":G,"../../../../packages/sema/migrations/0032_satis_teklifi.sql":P,"../../../../packages/sema/migrations/0033_baglam_auth_yetkisi.sql":$,"../../../../packages/sema/migrations/0034_dogrulanmis_kullanici.sql":x,"../../../../packages/sema/migrations/0035_kullanici_rol_izin.sql":B,"../../../../packages/sema/migrations/0036_search_path_sabit.sql":Y,"../../../../packages/sema/migrations/0037_durus_problem.sql":X,"../../../../packages/sema/migrations/0038_kesim_ayarlari.sql":j,"../../../../packages/sema/migrations/0039_firma_gunu.sql":J,"../../../../packages/sema/migrations/0040_artik_havuzu.sql":q,"../../../../packages/sema/migrations/0041_agacta_kullanilan_agacsiz.sql":V,"../../../../packages/sema/migrations/0042_kullanici_kaynak.sql":w,"../../../../packages/sema/migrations/0043_agacsiz_planlanmaz_haric.sql":Z,"../../../../packages/sema/migrations/0044_is_merkezi_takvim.sql":Q,"../../../../packages/sema/migrations/0045_kod_sablonu_tip_kapsami.sql":ii,"../../../../packages/sema/migrations/0046_bolum_istasyon.sql":ai,"../../../../packages/sema/migrations/0047_kullanici_sifre_degismeli.sql":ei,"../../../../packages/sema/migrations/0048_fason_tarifesi_agirlik.sql":ni,"../../../../packages/sema/migrations/0049_bolum_saat_maliyeti.sql":ri,"../../../../packages/sema/migrations/0050_saha_kaydi_geri_al.sql":ki,"../../../../packages/sema/migrations/0051_varsayim_gorunurlugu.sql":li,"../../../../packages/sema/migrations/0052_kod_sablonu_planlanmaz_haric.sql":ti,"../../../../packages/sema/migrations/0053_yabanci_anahtar_indeksleri.sql":si,"../../../../packages/sema/migrations/0054_varsayim_gorunumu_hizi.sql":Ei,"../../../../packages/sema/migrations/0055_dedektor_kume_isaretleme.sql":di,"../../../../packages/sema/migrations/0056_agirlik_kume_hesabi.sql":mi,"../../../../packages/sema/migrations/0058_recete_denetimi.sql":oi,"../../../../packages/sema/migrations/0059_kurulum_kontrol.sql":ui,"../../../../packages/sema/migrations/0060_kurulum_kontrol_saha.sql":_i,"../../../../packages/sema/migrations/0061_kurulum_kontrol_varsayim.sql":Ni,"../../../../packages/sema/migrations/0062_geri_al_negatif_stok.sql":yi,"../../../../packages/sema/migrations/0063_birim_yol_sirasi.sql":Li}),s=Object.assign({"../../../../packages/sema/firma/demo/0001_demo_as.sql":Ti,"../../../../packages/sema/firma/demo/0002_demo_rota.sql":ci,"../../../../packages/sema/firma/demo/0003_demo_fason_gun.sql":gi,"../../../../packages/sema/firma/demo/0004_demo_tedarik.sql":Ri,"../../../../packages/sema/firma/demo/0005_demo_fason_fiyat.sql":Ai,"../../../../packages/sema/firma/demo/0006_demo_lot_kalite.sql":Oi,"../../../../packages/sema/firma/demo/0007_demo_acilis_degeri.sql":Ii,"../../../../packages/sema/firma/demo/0008_demo_kur_genel_gider.sql":bi,"../../../../packages/sema/firma/demo/0009_demo_kaynak_teli_adim.sql":Si,"../../../../packages/sema/firma/demo/0010_demo_teklif_sayim.sql":pi,"../../../../packages/sema/firma/demo/0011_demo_saha_durus.sql":Ui,"../../../../packages/sema/firma/demo/0012_demo_kesim_artik.sql":Ci,"../../../../packages/sema/firma/ozler/0001_kurallar_ve_alanlar.sql":Di,"../../../../packages/sema/firma/ozler/0002_kod_sablonu_kapsami.sql":zi,"../../../../packages/sema/firma/ozler/0003_mamul_kod_serbest.sql":vi});async function hi(i){const n=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(Fi(i)));return[...new Uint8Array(n)].map(a=>a.toString(16).padStart(2,"0")).join("")}async function E(i,n){const a=[];for(const[r,e]of Object.entries(i)){const l=r.split("/").pop();if(!fi.test(l))continue;const k=n(r);k!==null&&a.push({surum:k+l.replace(/\.sql$/,""),icerik:e,checksum:await hi(e)})}return a.sort((r,e)=>r.surum<e.surum?-1:1)}function Ki(){return E(Mi,()=>"")}function Gi(){return[...new Set(Object.keys(s).map(i=>i.split("/").at(-2)))].sort()}function Wi(i){return E(s,n=>n.split("/").at(-2)===i?`firma:${i}/`:null)}async function Pi(i,n){const a=await t(i,await Ki());if(!n)return a;const r=await t(i,await Wi(n));return{uygulanan:[...a.uygulanan,...r.uygulanan],atlanan:[...a.atlanan,...r.atlanan]}}export{Ki as cekirdekMigrationlari,Wi as firmaMigrationlari,Gi as firmaPaketleri,Pi as kur};
