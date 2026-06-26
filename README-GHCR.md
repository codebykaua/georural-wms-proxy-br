# GeoRural Proxy WMS no Azure Brazil South sem ACR Tasks

Este pacote usa GitHub Actions para construir a imagem Docker e GitHub Container Registry (GHCR) para armazená-la. Isso evita o erro `TasksOperationsNotAllowed` do ACR Tasks.

## Fluxo

1. Crie no GitHub um repositório público chamado `georural-wms-proxy-br`.
2. Envie todo o conteúdo desta pasta para a raiz do repositório, inclusive `.github/workflows/publish-ghcr.yml`.
3. Abra a aba **Actions** e aguarde o workflow concluir com sucesso.
4. No seu perfil GitHub, abra **Packages**, selecione o pacote, depois **Package settings > Change visibility > Public**.
5. No Azure Cloud Shell, execute `bash DEPLOY_AZURE_GHCR_PUBLIC.sh`.

A API principal do GeoRural e o Azure SQL não são modificados.
