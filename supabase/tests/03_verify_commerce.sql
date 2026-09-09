-- =============================================================================
-- Verificacion de comercio: catalogo, pago, comprobante y resumen
-- =============================================================================
-- Se ejecuta despues de 01 y 02, sobre los datos que dejan.
-- =============================================================================

\set ON_ERROR_STOP on

-- Se actua como el backend, igual que en 01.
set role service_role;

-- -----------------------------------------------------------------------------
-- PRUEBA 20 · La ficha de producto se arma con los datos vigentes
-- -----------------------------------------------------------------------------
do $$
declare
  v_t     uuid;
  v_conv  uuid;
  v_prod  uuid;
  v_msg   uuid;
  v_m     public.messages;
  v_job   public.job_status;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select c.id into v_conv from public.conversations c where c.tenant_id = v_t limit 1;

  update public.company_settings
  set public_store_url = 'https://tienda.empresa-uno.pe'
  where tenant_id = v_t;

  insert into public.products (tenant_id, name, description, price, currency, images, sku)
  values (v_t, 'Programa de Mentorias Empresariales',
          '3 meses, 12 sesiones uno a uno.', 1650.00, 'PEN',
          array['https://cdn.empresa-uno.pe/mentorias.jpg'], 'PRG-MEN')
  returning id into v_prod;

  v_msg := public.enqueue_product_message(v_conv, v_prod);
  select * into v_m from public.messages where id = v_msg;

  if v_m.content not like '%Programa de Mentorias Empresariales%' then
    raise exception 'FALLO 20a: la ficha no lleva el nombre del producto';
  end if;
  if v_m.content not like '%1,650.00%' then
    raise exception 'FALLO 20b: la ficha no lleva el precio formateado. Contenido: %', v_m.content;
  end if;
  if v_m.content not like '%PEN%' then
    raise exception 'FALLO 20c: la ficha no indica la moneda';
  end if;
  if v_m.content not like '%https://tienda.empresa-uno.pe/p/%' then
    raise exception 'FALLO 20d: la ficha no lleva el enlace de la tienda';
  end if;
  if v_m.media_type <> 'image' or v_m.media_url <> 'https://cdn.empresa-uno.pe/mentorias.jpg' then
    raise exception 'FALLO 20e: la ficha no adjunta la imagen del producto';
  end if;

  select status into v_job from public.outbound_jobs where message_id = v_msg;
  if v_job <> 'queued' then
    raise exception 'FALLO 20f: la ficha no quedo encolada para envio';
  end if;

  raise notice 'OK 20 · La ficha se arma con nombre, precio, moneda, enlace e imagen vigentes';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 21 · Sin tienda configurada, la ficha no lleva un enlace roto
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid; v_conv uuid; v_prod uuid; v_msg uuid; v_contenido text;
begin
  select id into v_t from public.tenants where slug = 'empresa-dos';
  select c.id into v_conv from public.conversations c where c.tenant_id = v_t limit 1;

  insert into public.products (tenant_id, name, price, currency)
  values (v_t, 'Consultoria puntual', 900.00, 'PEN')
  returning id into v_prod;

  v_msg := public.enqueue_product_message(v_conv, v_prod);
  select content into v_contenido from public.messages where id = v_msg;

  if v_contenido like '%/p/%' or v_contenido like '%http%' then
    raise exception 'FALLO 21: se envio un enlace sin tienda configurada: %', v_contenido;
  end if;

  raise notice 'OK 21 · Sin tienda publica, la ficha se envia sin enlace en lugar de uno roto';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 22 · Un producto de otra empresa no se puede enviar
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv_uno uuid;
  v_prod_dos uuid;
  v_rechazado boolean := false;
begin
  select c.id into v_conv_uno from public.conversations c
   where c.tenant_id = (select id from public.tenants where slug = 'empresa-uno') limit 1;
  select p.id into v_prod_dos from public.products p
   where p.tenant_id = (select id from public.tenants where slug = 'empresa-dos') limit 1;

  begin
    perform public.enqueue_product_message(v_conv_uno, v_prod_dos);
  exception when others then
    v_rechazado := true;
  end;

  if not v_rechazado then
    raise exception 'FALLO 22: se envio a un cliente el producto de otra empresa';
  end if;
  raise notice 'OK 22 · No se puede enviar el producto de una empresa por la conversacion de otra';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 23 · Pago: descuenta stock, es idempotente y respeta el inventario
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid; v_contacto uuid; v_prod uuid; v_orden uuid;
  v_stock int; v_estado public.order_status;
  v_rechazado boolean := false;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select id into v_contacto from public.contacts where tenant_id = v_t limit 1;

  insert into public.products (tenant_id, name, price, currency, track_stock, stock_quantity, sku)
  values (v_t, 'Cuaderno de trabajo impreso', 35.00, 'PEN', true, 10, 'MAT-CUA')
  returning id into v_prod;

  insert into public.orders (tenant_id, contact_id, currency, status)
  values (v_t, v_contacto, 'PEN', 'pending_payment')
  returning id into v_orden;

  insert into public.order_items (tenant_id, order_id, product_id, name, unit_price, quantity)
  values (v_t, v_orden, v_prod, 'Cuaderno de trabajo impreso', 35.00, 3);

  perform public.mark_order_paid(v_orden, 'transferencia', 'OP-99887');

  select stock_quantity into v_stock from public.products where id = v_prod;
  select status into v_estado from public.orders where id = v_orden;

  if v_stock <> 7 then
    raise exception 'FALLO 23a: el stock quedo en % y deberia ser 7', v_stock;
  end if;
  if v_estado <> 'paid' then
    raise exception 'FALLO 23b: la orden quedo en % y no en paid', v_estado;
  end if;
  if (select paid_at from public.orders where id = v_orden) is null then
    raise exception 'FALLO 23c: la orden pagada no tiene fecha de pago';
  end if;

  -- Idempotencia: un reintento del proveedor de pago no descuenta otra vez.
  perform public.mark_order_paid(v_orden, 'transferencia', 'OP-99887');
  select stock_quantity into v_stock from public.products where id = v_prod;
  if v_stock <> 7 then
    raise exception 'FALLO 23d: el segundo cobro volvio a descontar stock (quedo en %)', v_stock;
  end if;

  -- Inventario insuficiente: se rechaza y se dice de que producto.
  declare
    v_orden2 uuid;
  begin
    insert into public.orders (tenant_id, contact_id, currency, status)
    values (v_t, v_contacto, 'PEN', 'pending_payment') returning id into v_orden2;

    insert into public.order_items (tenant_id, order_id, product_id, name, unit_price, quantity)
    values (v_t, v_orden2, v_prod, 'Cuaderno de trabajo impreso', 35.00, 50);

    begin
      perform public.mark_order_paid(v_orden2);
    exception when others then
      v_rechazado := true;
    end;
  end;

  if not v_rechazado then
    raise exception 'FALLO 23e: se cobro una orden con mas unidades que el stock';
  end if;
  if (select stock_quantity from public.products where id = v_prod) <> 7 then
    raise exception 'FALLO 23f: el cobro rechazado dejo el stock alterado';
  end if;

  raise notice 'OK 23 · Pago descuenta stock una sola vez y rechaza el cobro sin inventario';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 24 · Comprobante emitido desde la orden, con importes de sus lineas
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid; v_orden uuid; v_inv public.sales_invoices;
  v_lineas int; v_duplicado boolean := false;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select o.id into v_orden from public.orders o
   where o.tenant_id = v_t and o.status = 'paid'
   order by o.created_at desc limit 1;

  v_inv := public.issue_invoice_for_order(
    v_orden, 'boleta', 'B001', '44556677', 'Rosa Quispe Flores', 'Av. Espana 500, Trujillo'
  );

  -- 3 x 35.00 = 105.00 con IGV incluido -> base 88.98, IGV 16.02
  if v_inv.total <> 105.00 then
    raise exception 'FALLO 24a: total del comprobante % y la orden era 105.00', v_inv.total;
  end if;
  if round(v_inv.subtotal + v_inv.tax_amount, 2) <> v_inv.total then
    raise exception 'FALLO 24b: base + IGV no suman el total';
  end if;
  if v_inv.state <> 'issued' then
    raise exception 'FALLO 24c: el comprobante no quedo emitido';
  end if;
  if v_inv.full_number not like 'B001-%' then
    raise exception 'FALLO 24d: numeracion incorrecta: %', v_inv.full_number;
  end if;

  select count(*) into v_lineas from public.sales_invoice_items where invoice_id = v_inv.id;
  if v_lineas <> 1 then
    raise exception 'FALLO 24e: el comprobante tiene % lineas y la orden 1', v_lineas;
  end if;

  -- No se puede facturar dos veces la misma orden.
  begin
    perform public.issue_invoice_for_order(v_orden, 'boleta', 'B001', '44556677', 'Rosa Quispe Flores');
  exception when others then
    v_duplicado := true;
  end;

  if not v_duplicado then
    raise exception 'FALLO 24f: se emitio un segundo comprobante para la misma orden';
  end if;

  raise notice 'OK 24 · Comprobante % con importes copiados de la orden; no admite duplicado', v_inv.full_number;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 25 · Resumen financiero
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid;
  v_r record;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';

  insert into public.purchases_and_expenses (
    tenant_id, supplier_name, category, subtotal, tax_amount, total, currency, expense_date
  )
  values (v_t, 'Imprenta Trujillo SAC', 'Materiales', 50.00, 9.00, 59.00, 'PEN', current_date);

  select * into v_r from public.financial_summary(v_t, current_date - 1, current_date + 1);

  if v_r.comprobantes < 1 then
    raise exception 'FALLO 25a: el resumen no contabilizo ningun comprobante';
  end if;
  if v_r.gastos_total <> 59.00 then
    raise exception 'FALLO 25b: gastos = % y se esperaba 59.00', v_r.gastos_total;
  end if;
  if round(v_r.ventas_base + v_r.ventas_igv, 2) <> v_r.ventas_total then
    raise exception 'FALLO 25c: base + IGV de ventas no suman el total de ventas';
  end if;
  if v_r.resultado <> round(v_r.ventas_base - v_r.gastos_base, 2) then
    raise exception 'FALLO 25d: el resultado no es ventas sin IGV menos gastos sin IGV';
  end if;
  if v_r.igv_por_pagar <> round(v_r.ventas_igv - v_r.gastos_igv, 2) then
    raise exception 'FALLO 25e: el IGV por pagar no es el de ventas menos el de compras';
  end if;

  raise notice 'OK 25 · Resumen: ventas %, gastos %, resultado %, IGV por pagar %',
    v_r.ventas_total, v_r.gastos_total, v_r.resultado, v_r.igv_por_pagar;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 26 · Una nota de credito resta de las ventas
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid; v_inv uuid; v_antes numeric; v_despues numeric;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select ventas_total into v_antes from public.financial_summary(v_t, current_date - 1, current_date + 1);

  select id into v_inv from public.sales_invoices
   where tenant_id = v_t and kind = 'boleta' order by issued_at desc limit 1;

  insert into public.sales_invoices (
    tenant_id, contact_id, kind, series, correlative, receiver_tax_id, receiver_name,
    subtotal, tax_amount, total, state, references_invoice_id, reference_reason
  )
  select v_t, contact_id, 'nota_credito', 'BC01',
         public.next_correlative(v_t, 'nota_credito', 'BC01'),
         receiver_tax_id, receiver_name, subtotal, tax_amount, total, 'issued',
         id, 'Anulacion por acuerdo con el cliente'
  from public.sales_invoices where id = v_inv;

  select ventas_total into v_despues from public.financial_summary(v_t, current_date - 1, current_date + 1);

  if v_despues >= v_antes then
    raise exception 'FALLO 26: la nota de credito no resto (antes % despues %)', v_antes, v_despues;
  end if;

  raise notice 'OK 26 · La nota de credito resta de las ventas: % -> %', v_antes, v_despues;
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 27 · Vista publica de la orden
-- -----------------------------------------------------------------------------
-- Es el unico punto accesible sin sesion. Tiene que devolver lo justo.
-- -----------------------------------------------------------------------------
do $$
declare
  v_t uuid; v_orden public.orders; v_json jsonb; v_texto text;
begin
  select id into v_t from public.tenants where slug = 'empresa-uno';
  select * into v_orden from public.orders where tenant_id = v_t and status = 'paid'
   order by created_at desc limit 1;

  update public.company_settings
  set payment_instructions = 'BCP 191-0000000-0-11 · Yape 987654321'
  where tenant_id = v_t;

  -- Como lo abre el cliente: sin sesion.
  set local role anon;
  v_json := public.order_public_view(v_orden.public_token);
  set role service_role;

  if v_json is null then
    raise exception 'FALLO 27a: la orden no se pudo consultar con su token';
  end if;
  if (v_json->>'total')::numeric <> v_orden.total then
    raise exception 'FALLO 27b: el total de la vista publica no coincide';
  end if;
  if jsonb_array_length(v_json->'items') < 1 then
    raise exception 'FALLO 27c: la vista publica no trae las lineas';
  end if;
  if v_json->'empresa'->>'instrucciones' is null then
    raise exception 'FALLO 27d: no llegan las instrucciones de pago';
  end if;

  -- Lo que NO debe salir.
  v_texto := v_json::text;
  if v_texto like '%' || v_orden.contact_id::text || '%' then
    raise exception 'FALLO 27e: la vista publica expone el id del contacto';
  end if;
  if v_texto like '%20481234567%' then
    raise exception 'FALLO 27f: la vista publica expone el RUC de la empresa';
  end if;
  if v_texto like '%' || v_orden.id::text || '%' then
    raise exception 'FALLO 27g: la vista publica expone el id interno de la orden';
  end if;

  -- Token inexistente: nada, sin filtrar si la orden existe o no.
  set local role anon;
  if public.order_public_view('0000000000000000000000000000000000') is not null then
    set role service_role;
    raise exception 'FALLO 27h: un token inexistente devolvio datos';
  end if;
  if public.order_public_view('corto') is not null then
    set role service_role;
    raise exception 'FALLO 27i: un token demasiado corto devolvio datos';
  end if;
  set role service_role;

  raise notice 'OK 27 · Vista publica por token: trae lo necesario y no filtra ids ni RUC';
end $$;

-- -----------------------------------------------------------------------------
-- PRUEBA 28 · Sin sesion no se puede leer nada mas
-- -----------------------------------------------------------------------------
-- Hay dos formas validas de que esto quede bloqueado, y la primera es mas
-- fuerte que la segunda:
--   1. Sin privilegio de tabla: Postgres corta antes de evaluar la RLS.
--   2. Con privilegio pero sin politica para anon: la RLS devuelve cero filas.
-- Se acepta cualquiera de las dos. Lo que no se acepta es una sola fila.
do $$
declare
  v_tabla   text;
  v_filas   int;
  v_bloqueada boolean;
begin
  foreach v_tabla in array array[
    'orders', 'order_items', 'contacts', 'products', 'messages',
    'conversations', 'sales_invoices', 'knowledge_chunks',
    'channel_accounts', 'company_settings', 'tenants'
  ]
  loop
    v_bloqueada := false;
    begin
      set local role anon;
      execute format('select count(*) from public.%I', v_tabla) into v_filas;
      set role service_role;
      if v_filas = 0 then
        v_bloqueada := true;
      end if;
    exception when insufficient_privilege then
      set role service_role;
      v_bloqueada := true;
    end;

    if not v_bloqueada then
      raise exception 'FALLO 28: anon pudo leer % filas de %', v_filas, v_tabla;
    end if;
  end loop;

  raise notice 'OK 28 · Sin sesion, 11 tablas inaccesibles: la unica puerta es la vista publica de la orden';
end $$;

\echo ''
\echo '======================================================================'
\echo ' VERIFICACIONES DE COMERCIO: TODAS PASARON'
\echo '======================================================================'
