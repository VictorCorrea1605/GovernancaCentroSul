/**
 * ENGINES — motores de cálculo reutilizáveis do ONE PAGE EXECUTIVO.
 *
 * Princípio: BANCO → MOTOR → RESULTADO → DASHBOARD.
 * Nada aqui lê ou escreve o banco. Cada função é pura: recebe fatos
 * (entradas da competência, e quando necessário a série de meses
 * canônicos vigentes) e devolve um resultado. O "resultado" nunca é
 * persistido como fonte — é sempre derivado das entradas no momento
 * do uso, o que torna o reprocessamento automático: não há nada para
 * "corrigir" além dos fatos em si.
 */
(function (global) {
  "use strict";

  const STATUS = {
    VERDE: "verde",
    AMARELO: "amarelo",
    AZUL: "azul",
    VERMELHO: "vermelho",
    INFORMATIVO: "informativo",
    SEM_INFO: "sem_informacao",
  };

  const STATUS_LABEL = {
    verde: "Verde",
    amarelo: "Amarelo",
    azul: "Azul",
    vermelho: "Vermelho",
    informativo: "Informativo",
    sem_informacao: "Sem informação",
  };

  // ---------------------------------------------------------------------
  // MOTOR 10 — Consistência (validação). Roda antes de qualquer outro
  // motor: bloqueia salvar quando os fatos digitados são inconsistentes.
  // ---------------------------------------------------------------------
  function validarConsistencia(indicador, entradas) {
    const erros = [];
    const campos = indicador.camposEntrada || [];

    function num(v) {
      return typeof v === "number" && !Number.isNaN(v);
    }

    campos.forEach((campo) => {
      if (campo.tipo === "tabela") return; // validado à parte, abaixo
      const v = entradas[campo.key];
      if (campo.obrigatorio && (v === undefined || v === null || v === "")) {
        erros.push(`Campo obrigatório não preenchido: "${campo.label}".`);
        return;
      }
      if (v === undefined || v === null || v === "") return;
      if ((campo.tipo === "number" || campo.tipo === "integer") && !num(v)) {
        erros.push(`"${campo.label}" precisa ser numérico.`);
      }
      if (campo.tipo === "integer" && num(v) && !Number.isInteger(v)) {
        erros.push(`"${campo.label}" precisa ser um número inteiro.`);
      }
      if (num(v) && campo.min !== undefined && v < campo.min) {
        erros.push(`"${campo.label}" não pode ser menor que ${campo.min}.`);
      }
      if (num(v) && campo.max !== undefined && v > campo.max) {
        erros.push(`"${campo.label}" não pode ser maior que ${campo.max}.`);
      }
    });

    // Regras cruzadas específicas por motor (conformes <= total, % <= 100, etc.)
    switch (indicador.calc.motor) {
      case "percentual": {
        const { denominadorKey, denominadorEhTotal } = indicador.calc;
        const den = entradas[denominadorKey];
        const numV = valorNumerador(entradas, indicador.calc);
        if (num(den) && den === 0) {
          erros.push("Divisão por zero: o total informado é 0.");
        }
        if (num(den) && num(numV) && denominadorEhTotal && numV > den) {
          erros.push("O valor conforme/atendido não pode ser maior que o total avaliado.");
        }
        break;
      }
      case "percentual_duplo": {
        const total = entradas[indicador.calc.totalKey];
        const conf = entradas[indicador.calc.conformesKey];
        if (num(total) && total === 0) erros.push("Divisão por zero: total previsto é 0.");
        if (num(total) && num(conf) && conf > total) {
          erros.push("Contas conformes não pode ser maior que o total previsto.");
        }
        break;
      }
      case "razao_agregada": {
        const linhas = entradas[indicador.calc.tabelaKey] || [];
        if (!linhas.length) erros.push("Informe ao menos um veículo/linha na tabela.");
        linhas.forEach((l, i) => {
          if (!num(l[indicador.calc.denominadorSubKey]) || l[indicador.calc.denominadorSubKey] <= 0) {
            erros.push(`Linha ${i + 1}: litros abastecidos deve ser maior que zero.`);
          }
          if (!num(l[indicador.calc.numeradorSubKey]) || l[indicador.calc.numeradorSubKey] < 0) {
            erros.push(`Linha ${i + 1}: KM rodados inválido.`);
          }
        });
        break;
      }
      case "razao_simples": {
        const den = entradas[indicador.calc.denominadorKey];
        if (num(den) && den === 0) {
          erros.push(`Divisão por zero: "${indicador.calc.denominadorLabel || "quantidade"}" é 0. Se não houve movimento no mês, deixe o mês sem lançamento.`);
        }
        break;
      }
      case "media": {
        if (entradas.modo === "bruta") {
          if (num(entradas.qtdRegistros) && entradas.qtdRegistros === 0) {
            erros.push("Divisão por zero: quantidade de registros é 0.");
          }
        }
        break;
      }
      default:
        break;
    }

    return { valido: erros.length === 0, erros };
  }

  // ---------------------------------------------------------------------
  // MOTORES 1–7 e razão agregada — cálculo do resultado da competência
  // ---------------------------------------------------------------------
  function motorContagem(entradas, campoKey) {
    const v = entradas[campoKey];
    return typeof v === "number" ? v : null;
  }

  function motorSomaMensal(entradas, campos) {
    let soma = 0;
    let algum = false;
    campos.forEach((c) => {
      if (typeof entradas[c] === "number") {
        soma += entradas[c];
        algum = true;
      }
    });
    return algum ? soma : null;
  }

  function motorMedia(entradas) {
    if (entradas.modo === "fechada") {
      return typeof entradas.mediaFechada === "number" ? entradas.mediaFechada : null;
    }
    // modo bruto: soma dos tempos / qtd de registros
    if (typeof entradas.somaTempos === "number" && typeof entradas.qtdRegistros === "number" && entradas.qtdRegistros > 0) {
      return entradas.somaTempos / entradas.qtdRegistros;
    }
    return null;
  }

  function motorPercentual(entradas, numeradorKey, denominadorKey, denominadorEhTotal) {
    const den = entradas[denominadorKey];
    let num = entradas[numeradorKey];
    if (typeof den !== "number" || den === 0) return null;
    if (denominadorEhTotal && typeof entradas.__pendentesKey === "number") {
      // não utilizado — mantém assinatura simples
    }
    if (typeof num !== "number") return null;
    return (num / den) * 100;
  }

  // variante: percentual a partir de "total" e "pendentes" (conformes = total - pendentes)
  function motorPercentualPorPendencia(entradas, totalKey, pendentesKey) {
    const total = entradas[totalKey];
    const pend = entradas[pendentesKey];
    if (typeof total !== "number" || total === 0 || typeof pend !== "number") return null;
    const conformes = total - pend;
    return { resultado: (conformes / total) * 100, conformes, total, pendentes: pend };
  }

  function motorPercentualDuplo(entradas, totalKey, conformesKey) {
    const total = entradas[totalKey];
    const conf = entradas[conformesKey];
    if (typeof total !== "number" || total === 0 || typeof conf !== "number") return null;
    return (conf / total) * 100;
  }

  function motorSnapshot(entradas, campoKey) {
    const v = entradas[campoKey];
    return typeof v === "number" ? v : null;
  }

  // Motor 6 — acumulativo: soma SOMENTE os valores mensais canônicos vigentes.
  // Recebe a série já calculada (competência -> resultado mensal) e recalcula
  // do zero — nunca incrementa sobre um total anterior.
  function motorAcumulativo(serieMensal) {
    let soma = 0;
    let algum = false;
    Object.keys(serieMensal).forEach((comp) => {
      const v = serieMensal[comp];
      if (typeof v === "number") {
        soma += v;
        algum = true;
      }
    });
    return algum ? soma : null;
  }

  // Motor 7 — comparativo proporcional (ADM-015). serieCustos: { "2026-01": valor, ... }
  // Para o mês M do 2º semestre, compara Jan..(M-6) contra Jul..M.
  const MESES_2S = { 7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6 };
  function motorComparativoProporcional(serieCustos, ano, mesAtual) {
    if (!MESES_2S[mesAtual]) return null; // só se aplica de julho a dezembro
    const nMeses = MESES_2S[mesAtual];
    let periodo1 = 0, periodo2 = 0, completo = true;
    const detalhe1 = [], detalhe2 = [];
    for (let m = 1; m <= nMeses; m++) {
      const compP1 = `${ano}-${String(m).padStart(2, "0")}`;
      const compP2 = `${ano}-${String(m + 6).padStart(2, "0")}`;
      const v1 = serieCustos[compP1];
      const v2 = serieCustos[compP2];
      if (typeof v1 !== "number" || typeof v2 !== "number") completo = false;
      periodo1 += typeof v1 === "number" ? v1 : 0;
      periodo2 += typeof v2 === "number" ? v2 : 0;
      detalhe1.push({ competencia: compP1, valor: v1 ?? null });
      detalhe2.push({ competencia: compP2, valor: v2 ?? null });
    }
    if (periodo1 === 0) return { completo, periodo1, periodo2, percentual: null, detalhe1, detalhe2 };
    const percentual = ((periodo1 - periodo2) / periodo1) * 100;
    return { completo, periodo1, periodo2, percentual, detalhe1, detalhe2 };
  }

  // Razão agregada (ex.: ADM-023 combustível) — NUNCA média das médias.
  function motorRazaoAgregada(linhas, numeradorSubKey, denominadorSubKey) {
    let sN = 0, sD = 0;
    (linhas || []).forEach((l) => {
      if (typeof l[numeradorSubKey] === "number") sN += l[numeradorSubKey];
      if (typeof l[denominadorSubKey] === "number") sD += l[denominadorSubKey];
    });
    if (sD === 0) return null;
    return sN / sD;
  }

  // ---------------------------------------------------------------------
  // Agregação por PERÍODO (vários meses) — usada pelo Dashboard quando o
  // usuário escolhe "consolidado" em vez de um único mês. Cada motor tem
  // uma semântica própria de consolidação, nunca genérica:
  //  · fluxo mensal (contagem, soma_mensal_componentes) → SOMA no período;
  //  · percentuais (percentual, percentual_pendencia, percentual_duplo)
  //    → soma os numeradores/denominadores brutos do período e recalcula
  //    a razão (nunca "média das médias mensais");
  //  · razão agregada → soma numerador/denominador de TODAS as linhas de
  //    TODOS os meses do período, mesma regra do motor mensal;
  //  · média → média simples dos resultados mensais do período;
  //  · "fotografias" (snapshot, percentual_direto, faixa_contagem,
  //    comparativo_proporcional_anual) → não fazem sentido somados; o
  //    período mostra o valor vigente no ÚLTIMO mês do período com dado.
  // Sempre recalculado do zero a partir das entradas — nunca soma um
  // "resultado" pré-calculado que não possa ser reprocessado.
  // ---------------------------------------------------------------------
  function somaChaveNoPeriodo(entradasPorCompetencia, competencias, key) {
    let soma = 0, algum = false;
    competencias.forEach((comp) => {
      const e = entradasPorCompetencia[comp];
      if (e && typeof e[key] === "number") { soma += e[key]; algum = true; }
    });
    return algum ? soma : null;
  }

  function calcularResultadoPeriodo(indicador, entradasPorCompetencia, competenciasPeriodo) {
    const c = indicador.calc;
    // Indicador que começou a ser medido no meio do ano (competenciaInicial)
    // ignora tudo que vier antes — lançamento antigo não entra na conta.
    const inicio = indicador.competenciaInicial;
    const comDado = (competenciasPeriodo || []).filter(
      (comp) => (!inicio || comp >= inicio) && !!entradasPorCompetencia[comp]
    );
    const ultimaComDado = comDado.length ? comDado[comDado.length - 1] : null;

    function ultimoPonto() {
      if (!ultimaComDado) return { resultado: null, detalhes: null };
      return calcularResultadoCompetencia(indicador, entradasPorCompetencia[ultimaComDado]);
    }

    switch (c.motor) {
      case "snapshot":
      case "percentual_direto":
      case "comparativo_proporcional_anual":
      case "faixa_contagem": {
        // Por padrão são "fotografias" no tempo (fila atual, saldo, valor
        // vigente): o período exibe o último mês com lançamento, não uma
        // soma. Quando o indicador pede consolidacao "media" (ex.: ADM-026,
        // pesquisa de satisfação), o período vira a média dos meses medidos.
        if (c.consolidacao === "media") {
          const valores = comDado
            .map((comp) => calcularResultadoCompetencia(indicador, entradasPorCompetencia[comp]).resultado)
            .filter((v) => typeof v === "number");
          return {
            resultado: valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null,
            detalhes: [{ label: "Meses medidos", valor: valores.length }],
            competenciasComDado: comDado,
            ultimaComDado,
          };
        }
        const r = ultimoPonto();
        return { resultado: r.resultado, detalhes: r.detalhes, competenciasComDado: comDado, ultimaComDado };
      }

      case "percentual_conformidade_status": {
        // Consolidação escolhida: média simples dos percentuais mensais —
        // cada mês pesa igual, independente de quantas notas teve. O
        // percentual ponderado (por nota) vai no detalhamento, para quem
        // quiser comparar as duas leituras.
        const percentuais = [];
        let emitidas = 0, foraDoPrazo = 0, abertas = 0;
        comDado.forEach((comp) => {
          const e = entradasPorCompetencia[comp] || {};
          const totalMes = somarChaves(e, c.camposTotal);
          if (!totalMes) return;
          const descontaMes = somarChaves(e, c.camposDesconto);
          percentuais.push(((totalMes - descontaMes) / totalMes) * 100);
          emitidas += totalMes;
          foraDoPrazo += descontaMes;
          abertas += somarChaves(e, c.camposAbertos || []);
        });
        if (!percentuais.length) {
          return { resultado: null, detalhes: null, competenciasComDado: comDado, ultimaComDado };
        }
        const media = percentuais.reduce((a, b) => a + b, 0) / percentuais.length;
        return {
          resultado: media,
          detalhes: [
            { label: "Meses considerados", valor: percentuais.length },
            { label: "Emitidas no período", valor: emitidas },
            { label: "Já fora do prazo", valor: foraDoPrazo },
            { label: "Ainda sem retorno", valor: abertas },
            { label: "% ponderado por nota", valor: emitidas ? (((emitidas - foraDoPrazo) / emitidas) * 100).toFixed(1) : "—" },
          ],
          competenciasComDado: comDado,
          ultimaComDado,
        };
      }

      case "contagem":
      case "soma_mensal_componentes": {
        const campos = c.motor === "contagem" ? [c.campoKey] : c.campos;
        let soma = 0, algum = false;
        const porCampo = {};
        campos.forEach((k) => {
          porCampo[k] = somaChaveNoPeriodo(entradasPorCompetencia, comDado, k);
          if (typeof porCampo[k] === "number") { soma += porCampo[k]; algum = true; }
        });
        return {
          resultado: algum ? soma : null,
          detalhes: campos.map((k) => ({ label: k + " (período)", valor: porCampo[k] })),
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      case "media": {
        const valores = comDado
          .map((comp) => calcularResultadoCompetencia(indicador, entradasPorCompetencia[comp]).resultado)
          .filter((v) => typeof v === "number");
        const resultado = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
        return {
          resultado,
          detalhes: [{ label: "Meses considerados", valor: valores.length }],
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      case "percentual_pendencia": {
        const totalP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.totalKey);
        const pendP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.pendentesKey);
        if (typeof totalP !== "number" || totalP === 0) return { resultado: null, detalhes: null, competenciasComDado: comDado, ultimaComDado };
        const conformes = totalP - (pendP || 0);
        return {
          resultado: (conformes / totalP) * 100,
          detalhes: [
            { label: "Total avaliado (período)", valor: totalP },
            { label: "Pendentes (período)", valor: pendP },
            { label: "Conformes (calculado)", valor: conformes },
          ],
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      case "percentual": {
        const chavesNum = Array.isArray(c.camposNumerador) ? c.camposNumerador : [c.numeradorKey];
        const parciais = chavesNum.map((k) => somaChaveNoPeriodo(entradasPorCompetencia, comDado, k));
        const numP = parciais.some((v) => typeof v === "number")
          ? parciais.reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0)
          : null;
        const denP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.denominadorKey);
        if (typeof denP !== "number" || denP === 0 || typeof numP !== "number") return { resultado: null, detalhes: null, competenciasComDado: comDado, ultimaComDado };
        return {
          resultado: (numP / denP) * 100,
          detalhes: [
            { label: (c.numeradorLabel || "Numerador") + " (período)", valor: numP },
            { label: (c.denominadorLabel || "Denominador") + " (período)", valor: denP },
          ],
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      case "percentual_duplo": {
        const totalP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.totalKey);
        const confP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.conformesKey);
        if (typeof totalP !== "number" || totalP === 0 || typeof confP !== "number") return { resultado: null, detalhes: null, competenciasComDado: comDado, ultimaComDado };
        return {
          resultado: (confP / totalP) * 100,
          detalhes: [
            { label: (c.conformesLabel || "Conformes") + " (período)", valor: confP },
            { label: (c.totalLabel || "Total") + " (período)", valor: totalP },
          ],
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      case "razao_simples": {
        // Ponderado: Σ numerador ÷ Σ denominador do período — nunca a média
        // dos tickets mensais (um mês com 2 viagens não pesa igual a um com 40).
        const nP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.numeradorKey);
        const dP = somaChaveNoPeriodo(entradasPorCompetencia, comDado, c.denominadorKey);
        return {
          resultado: typeof nP === "number" && typeof dP === "number" && dP > 0 ? nP / dP : null,
          detalhes: [
            { label: (c.numeradorLabel || "Numerador") + " (período)", valor: nP },
            { label: (c.denominadorLabel || "Denominador") + " (período)", valor: dP },
          ],
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      case "razao_agregada": {
        let sN = 0, sD = 0;
        comDado.forEach((comp) => {
          const linhas = (entradasPorCompetencia[comp] && entradasPorCompetencia[comp][c.tabelaKey]) || [];
          linhas.forEach((l) => {
            if (typeof l[c.numeradorSubKey] === "number") sN += l[c.numeradorSubKey];
            if (typeof l[c.denominadorSubKey] === "number") sD += l[c.denominadorSubKey];
          });
        });
        return {
          resultado: sD > 0 ? sN / sD : null,
          detalhes: [{ label: "KM total (período)", valor: sN }, { label: "Litros totais (período)", valor: sD }],
          competenciasComDado: comDado, ultimaComDado,
        };
      }

      default:
        return { resultado: null, detalhes: null, competenciasComDado: comDado, ultimaComDado };
    }
  }

  // ---------------------------------------------------------------------
  // Dispatcher: calcula o resultado da COMPETÊNCIA a partir das entradas
  // (motores 1–5 + razão agregada). Não trata acumulado/comparativo —
  // isso é feito por calcularDerivado, que precisa da série de meses.
  // ---------------------------------------------------------------------
  /**
   * Numerador do motor "percentual": normalmente um campo só
   * (numeradorKey), mas pode ser a soma de vários (camposNumerador) —
   * usado quando mais de uma situação conta como conformidade. Ex.: no
   * ADM-008, o pagamento bloqueado por não conformidade é o controle
   * funcionando, então soma junto com os pagamentos conformes.
   */
  function valorNumerador(entradas, c) {
    if (Array.isArray(c.camposNumerador)) {
      const temAlgum = c.camposNumerador.some((k) => typeof (entradas || {})[k] === "number");
      return temAlgum ? somarChaves(entradas, c.camposNumerador) : null;
    }
    const v = (entradas || {})[c.numeradorKey];
    return typeof v === "number" ? v : null;
  }

  /** Soma as chaves informadas dentro de um lançamento (ignora vazio/ausente). */
  function somarChaves(entradas, chaves) {
    return (chaves || []).reduce((acc, k) => acc + (Number(entradas && entradas[k]) || 0), 0);
  }

  function calcularResultadoCompetencia(indicador, entradas) {
    if (!entradas || Object.keys(entradas).length === 0) {
      return { resultado: null, detalhes: null };
    }
    const c = indicador.calc;
    switch (c.motor) {
      case "contagem":
        return { resultado: motorContagem(entradas, c.campoKey), detalhes: null };

      case "soma_mensal_componentes": {
        const r = motorSomaMensal(entradas, c.campos);
        return {
          resultado: r,
          detalhes: c.campos.map((k) => ({ label: k, valor: entradas[k] ?? null })),
        };
      }

      case "media":
        return {
          resultado: motorMedia(entradas),
          detalhes:
            entradas.modo === "fechada"
              ? [{ label: "Média fechada informada", valor: entradas.mediaFechada ?? null }]
              : [
                  { label: "Soma dos tempos", valor: entradas.somaTempos ?? null },
                  { label: "Qtd. de registros", valor: entradas.qtdRegistros ?? null },
                ],
        };

      case "percentual_pendencia": {
        const r = motorPercentualPorPendencia(entradas, c.totalKey, c.pendentesKey);
        if (!r) return { resultado: null, detalhes: null };
        return {
          resultado: r.resultado,
          detalhes: [
            { label: "Total avaliado", valor: r.total },
            { label: "Pendentes", valor: r.pendentes },
            { label: "Conformes (calculado)", valor: r.conformes },
          ],
        };
      }

      case "percentual": {
        const den = entradas[c.denominadorKey];
        const num = valorNumerador(entradas, c);
        const resultado = typeof den === "number" && den !== 0 && num !== null ? (num / den) * 100 : null;
        return {
          resultado,
          detalhes: [
            { label: c.numeradorLabel || "Numerador", valor: num ?? null },
            { label: c.denominadorLabel || "Denominador (total)", valor: den ?? null },
          ],
        };
      }

      case "percentual_duplo": {
        const resultado = motorPercentualDuplo(entradas, c.totalKey, c.conformesKey);
        return {
          resultado,
          detalhes: [
            { label: c.conformesLabel || "Conformes", valor: entradas[c.conformesKey] ?? null },
            { label: c.totalLabel || "Total previsto", valor: entradas[c.totalKey] ?? null },
          ],
        };
      }

      case "snapshot":
        return { resultado: motorSnapshot(entradas, c.campoKey), detalhes: null };

      // Razão simples entre dois campos do mês (ex.: ticket médio = valor
      // gasto ÷ quantidade). Sem o "× 100" do percentual.
      case "razao_simples": {
        const n = entradas[c.numeradorKey], d = entradas[c.denominadorKey];
        return {
          resultado: typeof n === "number" && typeof d === "number" && d > 0 ? n / d : null,
          detalhes: [
            { label: c.numeradorLabel || "Numerador", valor: n ?? null },
            { label: c.denominadorLabel || "Denominador", valor: d ?? null },
          ],
        };
      }

      case "faixa_contagem": {
        // ADM-005: conta por faixa e o "resultado" é o total em aberto;
        // o status vem do motor de saúde (maior faixa com contagem > 0).
        const total = c.faixas.reduce((acc, f) => acc + (entradas[f.key] || 0), 0);
        return {
          resultado: total,
          detalhes: c.faixas.map((f) => ({ label: f.label, valor: entradas[f.key] ?? 0 })),
        };
      }

      case "razao_agregada": {
        const linhas = entradas[c.tabelaKey] || [];
        const resultado = motorRazaoAgregada(linhas, c.numeradorSubKey, c.denominadorSubKey);
        const totalKm = linhas.reduce((a, l) => a + (l[c.numeradorSubKey] || 0), 0);
        const totalLitros = linhas.reduce((a, l) => a + (l[c.denominadorSubKey] || 0), 0);
        return {
          resultado,
          detalhes: [
            { label: "KM total", valor: totalKm },
            { label: "Litros totais", valor: totalLitros },
            { label: "Veículos informados", valor: linhas.length },
          ],
        };
      }

      case "percentual_conformidade_status": {
        // ADM-005: as notas emitidas no mês se distribuem entre status. O
        // mês vale 100% e cada nota nos status que descontam (atrasada sem
        // retorno, ou retornada fora do prazo) tira da conformidade.
        const total = somarChaves(entradas, c.camposTotal);
        if (!total) return { resultado: null, detalhes: null };
        const desconta = somarChaves(entradas, c.camposDesconto);
        const abertas = somarChaves(entradas, c.camposAbertos || []);
        return {
          resultado: ((total - desconta) / total) * 100,
          detalhes: [
            { label: "Emitidas no mês", valor: total },
            { label: "Já fora do prazo (atrasadas + retornadas fora)", valor: desconta },
            { label: "Ainda sem retorno", valor: abertas },
          ],
        };
      }

      case "percentual_direto":
        return { resultado: motorSnapshot(entradas, c.campoKey), detalhes: null };

      case "comparativo_proporcional_anual":
        // Resultado "próprio" do mês é o fato bruto (custo mensal) — a
        // comparação em si é um derivado (motor 7), calculado à parte
        // a partir da série de todos os meses (ver calcularDerivado).
        return { resultado: motorSnapshot(entradas, "custoMensal"), detalhes: [{ label: "Custo mensal", valor: entradas.custoMensal ?? null }] };

      default:
        return { resultado: null, detalhes: null };
    }
  }

  // ---------------------------------------------------------------------
  // Derivados: acumulado / consolidado / comparativo proporcional.
  // Recebem a série completa (todas as competências vigentes já calculadas
  // pela função acima) — sempre recomputados do zero.
  // ---------------------------------------------------------------------
  function calcularDerivado(indicador, serieResultadosPorCompetencia, competenciaAtual) {
    const c = indicador.calc;
    if (c.acumulativo) {
      return { tipo: "acumulado", valor: motorAcumulativo(serieResultadosPorCompetencia) };
    }
    if (c.motor === "comparativo_proporcional_anual") {
      // aqui a série guarda o "resultado" mensal (custo) — usamos direto
      const [ano, mes] = competenciaAtual.split("-").map(Number);
      const serieAno = {};
      Object.keys(serieResultadosPorCompetencia).forEach((k) => {
        if (k.startsWith(String(ano) + "-")) serieAno[k] = serieResultadosPorCompetencia[k];
      });
      return { tipo: "comparativo", valor: motorComparativoProporcional(serieAno, ano, mes) };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // MOTOR 8 — Faixa de saúde (N bandas, suporta azul nativamente)
  // ---------------------------------------------------------------------
  function motorFaixaSaude(valor, faixas) {
    // faixas: [{ate: 90, status:'verde'}, {ate:120,status:'amarelo'}, {ate:150,status:'azul'}, {ate:Infinity,status:'vermelho'}]
    if (typeof valor !== "number") return STATUS.SEM_INFO;
    for (const f of faixas) {
      if (valor <= f.ate) return f.status;
    }
    return faixas[faixas.length - 1].status;
  }

  // faixa por maior contagem em banda (ADM-005): usa a banda mais severa com qtd>0
  function motorFaixaPorContagem(detalhes, ordemStatusDoMelhorAoPior) {
    if (!Array.isArray(detalhes)) return STATUS.SEM_INFO; // sem lançamento nesta competência
    // detalhes: [{label, valor}] na mesma ordem de ordemStatusDoMelhorAoPior
    for (let i = ordemStatusDoMelhorAoPior.length - 1; i >= 0; i--) {
      if ((detalhes[i] && detalhes[i].valor || 0) > 0) return ordemStatusDoMelhorAoPior[i];
    }
    return STATUS.VERDE;
  }

  // ---------------------------------------------------------------------
  // MOTOR 9 — Saúde por direção (maior/menor é melhor) com limites %.
  // Também cobre "regra específica" (informativo / sem semáforo).
  // ---------------------------------------------------------------------
  function motorSaudePorDirecao(valor, direcao, limites) {
    if (typeof valor !== "number") return STATUS.SEM_INFO;
    const { verde, amarelo } = limites || {};
    if (direcao === "maior_melhor") {
      if (verde !== undefined && valor >= verde) return STATUS.VERDE;
      if (amarelo !== undefined && valor >= amarelo) return STATUS.AMARELO;
      return STATUS.VERMELHO;
    }
    if (direcao === "menor_melhor") {
      if (verde !== undefined && valor <= verde) return STATUS.VERDE;
      if (amarelo !== undefined && valor <= amarelo) return STATUS.AMARELO;
      return STATUS.VERMELHO;
    }
    return STATUS.SEM_INFO;
  }

  function motorSaudeFaixaAssinada(valor, faixaPositiva, faixaNegativa) {
    // ADM-019 banco de horas: faixas configuráveis para saldo >=0 e <0
    if (typeof valor !== "number") return STATUS.SEM_INFO;
    if (valor >= 0) return motorFaixaSaude(valor, faixaPositiva);
    return motorFaixaSaude(-valor, faixaNegativa); // faixaNegativa definida em magnitude
  }

  // Dispatcher de saúde: interpreta indicador.saude (dado de cadastro) — nunca hardcoded por id.
  function calcularSaude(indicador, resultado, detalhesCompetencia) {
    const s = indicador.saude;
    if (!s) return STATUS.SEM_INFO;
    switch (s.tipo) {
      case "maior_melhor":
      case "menor_melhor":
        return motorSaudePorDirecao(resultado, s.tipo, s.limites);
      case "faixa":
        return motorFaixaSaude(resultado, s.faixas);
      case "faixa_por_contagem":
        return motorFaixaPorContagem(detalhesCompetencia, s.ordem);
      case "faixa_assinada":
        return motorSaudeFaixaAssinada(resultado, s.faixaPositiva, s.faixaNegativa);
      case "informativo":
        return STATUS.INFORMATIVO;
      default:
        return STATUS.SEM_INFO;
    }
  }

  global.Engines = {
    STATUS,
    STATUS_LABEL,
    validarConsistencia,
    calcularResultadoCompetencia,
    calcularResultadoPeriodo,
    calcularDerivado,
    calcularSaude,
    motorComparativoProporcional,
    MESES_2S,
  };
})(window);
