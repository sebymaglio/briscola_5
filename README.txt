# Briscola a 5-by Sebastiano Magliocco
**Cosa cambia in questa versione**
- **Niente punteggio live**: la schermata Punti è stata rimossa. Durante la mano non si vedono punteggi.
- **Esito a fine partita**: appare un riquadro con i **totali** (Chiamatore+Compagno vs Avversari) e l’esito **“Hai vinto/Hai perso”**.
- **Regola di vittoria**: Chiamatore+Compagno vincono se raggiungono almeno i **punti chiamati**; altrimenti vincono i 3 avversari.
- Testo e UI aggiornati: titolo **“Briscola a 5-by Sebastiano Magliocco”**, campo stanza con default **“nome stanza”**, etichette **“password”**.

**Resto delle funzionalità**
- Asta con primo offerente **random**, opzione primo leader **(chi inizia l’asta / 4♦)**, pass definitivo, reset partita (host), **ultima presa** (host), conferma presa (host), **mazzi** Siciliane/Savana (con dorsi legati), ordinamento mano per seme, **password** stanza, kick.

## Avvio
```bash
npm init -y
npm i express socket.io
node server.js
```
Apri `http://localhost:3000` (per test singolo: `?room=nome%20stanza&debug=1` su 5 tab).
