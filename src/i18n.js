// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the inverter or of the network stack: only our own words,
// error codes and the values we checked.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (ms >= 60_000) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** Our words for an error code of src/evt800/client.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  closed: {
    en: 'connection closed before any frame',
    fr: 'connexion fermée avant toute trame',
  },
  silent: { en: 'no frame for 90 s', fr: 'aucune trame depuis 90 s' },
  flood: { en: 'far too much data', fr: 'beaucoup trop de données' },
  unknown_answer: {
    en: 'not the frames of an EVT800 at this address and port',
    fr: 'ce ne sont pas les trames d’un EVT800 à cette adresse et ce port',
  },
};

export function reason(err) {
  return REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
}

const kwh = (value) => Math.round(value * 1000) / 1000;

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: join('en', first, notes),
  fr: join('fr', first, notes),
});

export const T = {
  noAddress: {
    en: 'Enter the address of your Envertech EVT800 micro-inverter (its IP address on your network, e.g. 192.168.1.80).',
    fr: 'Saisissez l’adresse de votre micro-onduleur Envertech EVT800 (son adresse IP sur votre réseau, ex. 192.168.1.80).',
  },
  badAddress: {
    en: 'The address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.80, port 14889 by default).',
    fr: 'L’adresse n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.80, port 14889 par défaut).',
  },
  connecting: (address) => ({
    en: `Connecting to the Envertech inverter at ${address} (by day: it is powered by its panels).`,
    fr: `Connexion à l’onduleur Envertech à l’adresse ${address} (de jour : il est alimenté par ses panneaux).`,
  }),
  waitingFrame: (address) => ({
    en: `Connected to ${address}: waiting for the first frame of the inverter.`,
    fr: `Connecté à ${address} : en attente de la première trame de l’onduleur.`,
  }),
  /** `notes`: { en, fr } texts added after the failure (an index held back). */
  unreachable: (address, err, wait, notes = []) =>
    withNotes(
      {
        en: `The Envertech inverter at ${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
        fr: `L’onduleur Envertech à l’adresse ${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  /** The night: not an error. */
  asleep: (address, notes = []) =>
    withNotes(
      {
        en: `The Envertech inverter at ${address} does not answer: it is asleep (no sun), it goes on at sunrise. If it is daytime, check its address, its Wi-Fi, its "TCP server" mode, and that no other program (Home Assistant...) is connected to it: the inverter may refuse a second client.`,
        fr: `L’onduleur Envertech à l’adresse ${address} ne répond pas : il est en veille (pas de soleil), il reprend au lever du soleil. S’il fait jour, vérifiez son adresse, son Wi-Fi, son mode « serveur TCP », et qu’aucun autre programme (Home Assistant…) n’y est connecté : l’onduleur peut refuser un second client.`,
      },
      notes,
    ),
  /** No frame at all for a day: red, even at night. */
  silent: (address, notes = []) =>
    withNotes(
      {
        en: `The Envertech inverter at ${address} has sent no frame for more than a day: check its address, its Wi-Fi, its "TCP server" mode and its panels (snow?). New try every 5 minutes.`,
        fr: `L’onduleur Envertech à l’adresse ${address} n’a envoyé aucune trame depuis plus d’un jour : vérifiez son adresse, son Wi-Fi, son mode « serveur TCP » et ses panneaux (neige ?). Nouvel essai toutes les 5 minutes.`,
      },
      notes,
    ),
  noDevice: (serial) => ({
    en: `Envertech inverter ${serial} found: create its device from the "Discover" tab to receive its values.`,
    fr: `Onduleur Envertech ${serial} trouvé : créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs.`,
  }),
  /** `notes`: { en, fr } texts added after the connection message. */
  ok: (address, notes = []) =>
    withNotes(
      {
        en: `Connected to the Envertech inverter (${address}).`,
        fr: `Connecté à l’onduleur Envertech (${address}).`,
      },
      notes,
    ),
  notes: {
    noIndex: {
      en: 'The last frame did not give the lifetime counter of every input: no production index for it.',
      fr: 'La dernière trame ne donnait pas le compteur total de chaque entrée : pas d’index de production pour elle.',
    },
    noSerial: {
      en: 'The last frame had no readable serial number: ignored.',
      fr: 'La dernière trame n’avait pas de numéro de série lisible : ignorée.',
    },
    otherInverter: (serial) => ({
      en: `Another inverter answers at this address (serial ${serial}): its values go to its own device, never to the previous one.`,
      fr: `Un autre onduleur répond à cette adresse (numéro de série ${serial}) : ses valeurs vont à son propre appareil, jamais au précédent.`,
    }),
    held: ({ direction, from, to }) => {
      if (direction === 'down') {
        return {
          en: `The solar production index went back from ${kwh(from)} to ${kwh(to)} kWh: held back, the last accepted value is sent again. If the counter of the inverter was really reset, click "Accept the held index" in the configuration of the integration (nothing is counted for the drop, the index goes on from there). If such a drop comes back every morning, do not accept it each day: report it (the integration then needs a fix). Saving the configuration accepts nothing.`,
          fr: `L’index de production solaire est revenu de ${kwh(from)} à ${kwh(to)} kWh : retenu, la dernière valeur acceptée est renvoyée. Si le compteur de l’onduleur a vraiment été remis à zéro, cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration (rien n’est compté pour la baisse, l’index repart de là). Si une telle baisse revient chaque matin, ne l’acceptez pas chaque jour : signalez-la (l’intégration doit alors être corrigée). Enregistrer la configuration n’accepte rien.`,
        };
      }
      const diff = kwh(to - from);
      return {
        en: `The solar production index jumped from ${kwh(from)} to ${kwh(to)} kWh: held back, not sent to the energy monitoring. If you click "Accept the held index" in the configuration of the integration, ${diff} kWh will be counted at once; accept only if this energy was produced since the last value (never an old counter shown again). Saving the configuration accepts nothing.`,
        fr: `L’index de production solaire a sauté de ${kwh(from)} à ${kwh(to)} kWh : retenu, non envoyé au suivi énergétique. Si vous cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration, ${diff} kWh seront comptés d’un coup ; n’acceptez que si cette énergie a été produite depuis la dernière valeur (jamais un ancien compteur réaffiché). Enregistrer la configuration n’accepte rien.`,
      };
    },
  },
  accept: {
    nothing: {
      en: 'No index is held back: nothing to accept.',
      fr: 'Aucun index n’est retenu : rien à accepter.',
    },
    up: ({ from, to }) => ({
      en: `Accepted: the solar production index ${kwh(to)} kWh will be sent with the next frame, and ${kwh(to - from)} kWh (plus what comes meanwhile) will be counted at once. A different value stays held.`,
      fr: `Accepté : l’index de production solaire ${kwh(to)} kWh sera envoyé avec la prochaine trame, et ${kwh(to - from)} kWh (plus ce qui vient d’ici là) seront comptés d’un coup. Une autre valeur reste retenue.`,
    }),
    down: ({ from, to }) => ({
      en: `Accepted: the solar production index goes back from ${kwh(from)} to ${kwh(to)} kWh with the next frame; nothing is counted for the drop, the index goes on from there. A different value stays held.`,
      fr: `Accepté : l’index de production solaire revient de ${kwh(from)} à ${kwh(to)} kWh avec la prochaine trame ; rien n’est compté pour la baisse, l’index repart de là. Une autre valeur reste retenue.`,
    }),
  },
  test: {
    /** The last frame, `ago` ms ago. */
    reading: ({ serial, power, inputs }, ago, connected) => ({
      en: `${ago > 0 ? `Last frame ${delay(ago).en} ago` : 'Frame received now'}: Envertech inverter ${serial}, ${inputs} input(s), ${power} W.${connected ? ' Connected.' : ''}`,
      fr: `${ago > 0 ? `Dernière trame il y a ${delay(ago).fr}` : 'Trame reçue à l’instant'} : onduleur Envertech ${serial}, ${inputs} entrée(s), ${power} W.${connected ? ' Connecté.' : ''}`,
    }),
    asleep: (ago, next) => ({
      en: `${ago > 0 ? `Last try ${delay(ago).en} ago` : 'Tried now'}: the inverter is asleep (no sun).${next > 0 ? ` Next try in ${delay(next).en}.` : ''}`,
      fr: `${ago > 0 ? `Dernier essai il y a ${delay(ago).fr}` : 'Essayé à l’instant'} : l’onduleur est en veille (pas de soleil).${next > 0 ? ` Prochain essai dans ${delay(next).fr}.` : ''}`,
    }),
    failed: (address, err, ago, next) => ({
      en: `${ago > 0 ? `Last try ${delay(ago).en} ago` : 'Tried now'}: the inverter at ${address} could not be read (${reason(err).en}). Next try in ${delay(next).en}.`,
      fr: `${ago > 0 ? `Dernier essai il y a ${delay(ago).fr}` : 'Essayé à l’instant'} : l’onduleur à l’adresse ${address} n’a pas pu être lu (${reason(err).fr}). Prochain essai dans ${delay(next).fr}.`,
    }),
    waiting: {
      en: 'Connected: no frame of the inverter yet. Look at the integration status in a minute.',
      fr: 'Connecté : pas encore de trame de l’onduleur. Regardez l’état de l’intégration dans une minute.',
    },
    notYet: (next) => ({
      en: `No frame yet with this configuration: the next connection comes in ${delay(next).en} (never more than one a minute).`,
      fr: `Pas encore de trame avec cette configuration : la prochaine connexion vient dans ${delay(next).fr} (jamais plus d’une par minute).`,
    }),
    slow: {
      en: 'The inverter is slow to send a frame: look at the integration status in a minute.',
      fr: 'L’onduleur tarde à envoyer une trame : regardez l’état de l’intégration dans une minute.',
    },
  },
};
