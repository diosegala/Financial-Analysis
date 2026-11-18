# IRPJ e CSLL

O app calcula o IRPJ e a CSLL do lucro real por trimestre, sobre o resultado da empresa, e mostra a parte de cada unidade
na DRE.

## Cálculo, por trimestre

1. **Resultado:** a Contribuição líquida de todas as unidades nos três meses. O resultado inteiro conta como da empresa do
   lucro real.
2. **(+) Despesas não dedutíveis:** voltam para a base.
3. **(=) Lucro real.** Negativo vira saldo de prejuízo, e o trimestre não tem imposto.
4. **(−) Compensação:** o saldo de prejuízo abate até o limite de compensação do lucro real do trimestre.
5. **IRPJ:** alíquota × base, mais o adicional sobre a parte da base acima do limite do trimestre.
6. **CSLL:** alíquota × base.
7. **Pagamento:** cota única, N meses depois do fim do trimestre.
   - O 4º trimestre cai no ano seguinte e fica fora do plano do ano.
   - O 4º trimestre do ano anterior entra no começo do ano, com o valor informado em Parâmetros.

## Rateio entre as unidades

- **Unidades de negócio:** cada uma recebe a parte proporcional à sua receita bruta no trimestre da apuração.
- **Trimestre sem receita:** vale a receita do ano.
- **Áreas de apoio:** não recebem imposto.
- **Onde aparece:**
  - na DRE, as linhas "IRPJ e CSLL" e "Resultado líquido" vêm depois da Contribuição líquida;
  - o limite de custos do diretor não muda;
  - o diretor vê a parte da unidade dele, calculada sobre o total da empresa.

## Onde configurar

- **Parâmetros:**
  - alíquotas do IRPJ, do adicional e da CSLL;
  - limite do adicional por trimestre;
  - limite de compensação de prejuízo;
  - meses até o pagamento;
  - valor do 4º trimestre do ano anterior.

  Sem valor, o imposto fica zero.

- **Plano de contas:** "Não dedutível no IRPJ/CSLL" vale para todas as despesas da conta, inclusive as já lançadas.
- **Lançamentos (só o financeiro):**
  - no menu da categoria, marcar todas as linhas;
  - na linha aberta, o botão "Dedutível" / "Não dedutível" faz a exceção daquela linha.
- **Fora da marcação por linha:**
  - folha, encargos e benefícios;
  - linhas da planilha de Educação (seguem a conta);
  - taxas e impostos da planilha.
- **Plano CUPOLA:** em "Ver a DRE da empresa", o quadro "IRPJ e CSLL por trimestre" mostra a apuração.
