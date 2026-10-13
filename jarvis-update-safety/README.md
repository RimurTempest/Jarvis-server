# JARVIS — primeira camada de segurança para atualizações

Esta pasta é um **módulo inicial isolado**, ainda não conectado ao deploy do Render nem ao instalador Android. Ele cria o inventário de funcionalidades que não podem desaparecer silenciosamente e uma barreira de liberação que falha em modo seguro.

## O que já está incluído

- `feature-registry.json`: inventário inicial de funções conhecidas do JARVIS.
- `validate-release.mjs`: valida o relatório de regressão; falha se uma função obrigatória não tiver resultado `pass` com evidência, se o rollback/banco/assinatura não tiverem sido verificados, ou se faltarem dados de versão.
- `test/validate-release.test.mjs`: testes automatizados do próprio bloqueio, incluindo um contrato para detectar remoções acidentais das funcionalidades de baseline.
- `examples/regression-report.example.json`: formato de exemplo, deliberadamente marcado como **não liberável** até que verificações reais sejam executadas.

## Executar os testes

Requer Node.js 18 ou superior; não requer dependências extras:

```sh
node --test test/validate-release.test.mjs
```

## Validar um candidato

Copie o exemplo para `regression-report.json`, substitua todos os valores de exemplo por evidências reais e execute:

```sh
node validate-release.mjs --registry feature-registry.json --report regression-report.json
```

O campo `ok` indica se as verificações declaradas passaram; ele não autoriza, sozinho, a instalação. O campo `installAllowed` só será `true` quando todas as verificações passarem e `ownerApproval` for explicitamente `approved`. No modo de linha de comando, o código de saída é `0` somente quando a instalação está autorizada; falhas de validação ou aprovação pendente retornam `1`, e problemas ao ler os arquivos retornam `2`.

## Política para o exemplo microfone + memória

Se o microfone passar, mas a memória falhar, a validação bloqueia a atualização. O JARVIS deverá corrigir o candidato em uma cópia isolada e executar novamente os testes. Se não conseguir corrigir com segurança, deve manter/restaurar a versão estável.

## Limites importantes

1. O inventário é um primeiro baseline baseado nas funções conhecidas; deve ser conferido contra a versão real do app antes de ser tratado como completo.
2. Este módulo **não cria backups, não compila APKs, não publica releases e não instala atualizações**. Ele apenas impede que um relatório incompleto seja considerado aprovado.
3. A verificação de assinatura deve comparar o certificado do APK candidato com o da versão instalada sem revelar nem embutir a keystore. O validador exige a confirmação dessa verificação, mas não a executa sozinho.
4. A restauração do código não reverte automaticamente alterações no banco. Migrações e recuperação dos dados precisam ser testadas separadamente.
5. O APK antigo não pode simplesmente ser instalado por downgrade de `versionCode` em condições normais do Android. A recuperação do app deve usar uma compilação estável assinada com a mesma chave e um `versionCode` superior.
6. O módulo e seu workflow estão versionados no GitHub. Eles ainda não estão integrados ao deploy do Render nem ao instalador Android, e não fazem backup, rollback ou instalação automática.


## Proposta de atualização com aprovação explícita

`update-proposal.mjs` valida o resumo que será apresentado ao responsável antes de uma atualização: versão atual/nova, lista de mudanças tipadas, explicação de permissões, URL HTTPS e hash SHA-256 do pacote. `decideUpdateApproval` só aceita uma decisão explícita do responsável e mantém uma recusa como recusa.

Teste com:

```sh
node --test test/update-proposal.test.mjs
```

**Limite atual:** isto é a camada de política/validação dos metadados, não um instalador. Um hash fornecido pela própria proposta não comprova autenticidade; o cliente precisa baixar o pacote, calcular o hash e comparar, validar a assinatura/certificado do APK e usar o fluxo de instalação do Android. A aprovação não ignora esses controles. A interface Android, armazenamento durável da decisão e integração com o instalador serão implementados depois de inspecionar o projeto Android real. Nenhum APK é criado, publicado ou instalado por este módulo.
