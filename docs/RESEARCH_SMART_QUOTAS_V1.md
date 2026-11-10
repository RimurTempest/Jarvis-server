# JARVIS — cotas inteligentes de pesquisa, sem APK novo

Esta atualização é **exclusivamente no servidor**; preserva a API
`POST /api/research/query`, que já é usada pelo Android 2.7.6.

## Limites por tipo de fonte

- **100 pedidos de pesquisa por dia por aparelho pareado** (dia UTC).
  Substitui o limite anterior de seis. É um limite da rota inteira,
  não significa 100 pedidos garantidos aos provedores externos.
- **Agência Brasil**: RSS público, sem chave e sem franquia paga; participa
  das pesquisas nacionais e respeita a cota de 100 por telefone.
- **GDELT**: notícias internacionais, sem chave e sem franquia paga;
  também respeita a cota de 100 por telefone.
- **Tavily**: no máximo **5 consultas/dia para TODO o servidor**, somando
  todos os dispositivos, e **só após** autorização e confirmação gratuita.
- **EXA**: no máximo **3 consultas/dia para TODO o servidor**, somando
  todos os dispositivos, e **só após** autorização e confirmação gratuita.

O número cinco/três é uma proteção conservadora inicial, não uma
afirmação sobre o limite gratuito real do provedor. A disponibilidade
depende do plano, do serviço e das regras de uso. Limites locais menores
não eliminam a necessidade de confirmar que a conta não aceita cobranças.

Os limites utilizam UPSERT atômico no PostgreSQL; dois celulares não
conseguem reservar simultaneamente uma mesma última posição da cota.
Quando o banco não está disponível, as chamadas externas ficam bloqueadas,
não há fallback pago.

## Cache
- Feed RSS da Agência Brasil: cache temporário em memória de 3 minutos.
- GDELT: cache temporário de 3 minutos por consulta.
- No máximo 64 entradas em memória; falhas não são guardadas.
- Não é necessário gravar texto da pesquisa em banco para usar o cache.
- A consulta ainda conta como pedido diário ao aplicativo, mas não
  necessariamente cria outra requisição pública.

## Política de custos intacta

O Render já contém `TAVILY_API_KEY` e `EXA_API_KEY`, mas o inventário
de nomes não mostrou o conjunto de flags que habilita esses pesquisadores.
Por isso, **continuam desativados** até a conferência dos planos e
autorização explícita. A nova cota não ativa nenhum provedor automaticamente.

## Compatibilidade
O aplicativo Android envia `query`, recebe `results` e trata HTTP 429.
Nenhuma propriedade obrigatória foi alterada. Os novos limites são
gerenciados pelo servidor e aparecem na API de status. Nenhuma reinstalação,
novo pareamento ou substituição de APK é necessária.

A publicação ocorre por merge na branch ativa do Render
`feature/android-device-enrollment-foundation`, seguida de deploy.
A nova cota entra em vigor assim que a versão estiver live. A JARVIS
2.7.6 deve continuar instalada.
