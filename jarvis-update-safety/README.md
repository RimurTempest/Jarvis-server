# JARVIS — primeira camada de segurança para atualizações

Esta pasta é um **módulo inicial isolado**, ainda não conectado ao deploy do Render nem ao instalador Android. Ele cria o inventário de funcionalidades que não podem desaparecer silenciosamente e uma barreira de liberação que falha em modo seguro.

## O que já está incluído

- `feature-registry.json`: inventário inicial de funções conhecidas do JARVIS.
- `validate-release.mjs`: valida o relatório de regressão; falha se uma função obrigatória não tiver resultado `pass` com evidência, se o rollback/banco/assinatura não tiverem sido verificados, ou se faltarem dados de versão.
- `test/validate-release.test.mjs`: testes automatizados do próprio bloqueio.
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

Código de saída `0` significa que a política passou. Qualquer função ausente, falha, desconhecida ou sem evidência bloqueia a liberação. Mesmo com testes aprovados, `installAllowed` só é `true` quando `ownerApproval` é explicitamente `approved`.

## Política para o exemplo microfone + memória

Se o microfone passar, mas a memória falhar, a validação bloqueia a atualização. O JARVIS deverá corrigir o candidato em uma cópia isolada e executar novamente os testes. Se não conseguir corrigir com segurança, deve manter/restaurar a versão estável.

## Limites importantes

1. O inventário é um primeiro baseline baseado nas funções conhecidas; deve ser conferido contra a versão real do app antes de ser tratado como completo.
2. Este módulo **não cria backups, não compila APKs, não publica releases e não instala atualizações**. Ele apenas impede que um relatório incompleto seja considerado aprovado.
3. A verificação de assinatura deve comparar o certificado do APK candidato com o da versão instalada sem revelar nem embutir a keystore. O validador exige a confirmação dessa verificação, mas não a executa sozinho.
4. A restauração do código não reverte automaticamente alterações no banco. Migrações e recuperação dos dados precisam ser testadas separadamente.
5. O APK antigo não pode simplesmente ser instalado por downgrade de `versionCode` em condições normais do Android. A recuperação do app deve usar uma compilação estável assinada com a mesma chave e um `versionCode` superior.
6. Não existe conexão ou publicação no GitHub/Render nesta entrega; o repositório remoto não foi alterado.
