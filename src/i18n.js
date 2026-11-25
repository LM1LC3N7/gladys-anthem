// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration button, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

export const T = {
  noDevice: both(
    'No device known yet: type their IP addresses in the configuration.',
    'Aucun appareil connu : saisissez leurs adresses IP dans la configuration.',
  ),
  check: (lines, maxVolume) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${maxVolume}%`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${maxVolume} %`].join(' · '),
  }),
  checkLine: (label, state) => {
    if (state === null || state === undefined) {
      return both(
        `${label}: not connected (IP control in standby off, unplugged or unreachable)`,
        `${label} : non connecté (contrôle IP en veille désactivé, débranché ou injoignable)`,
      );
    }
    const en = [state.power === true ? 'on' : state.power === false ? 'off' : 'power unknown'];
    const fr = [
      state.power === true ? 'allumée' : state.power === false ? 'éteinte' : 'marche inconnue',
    ];
    if (Number.isInteger(state.volume)) {
      en.push(`volume ${state.volume}%`);
      fr.push(`volume ${state.volume} %`);
    }
    if (typeof state.mute === 'boolean') {
      en.push(state.mute ? 'muted' : 'not muted');
      fr.push(state.mute ? 'en sourdine' : 'sans sourdine');
    }
    return both(`${label}: connected, ${en.join(', ')}`, `${label} : connectée, ${fr.join(', ')}`);
  },
  unreachable: (names) =>
    both(
      `Not connected (IP control in standby off, unplugged or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Non connectés (contrôle IP en veille désactivé, débranchés ou injoignables), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Anthem device answers yet at: ${list(addresses)}.`,
      `Aucun appareil Anthem ne répond encore à : ${list(addresses)}.`,
    ),
  invalidEntries: (count) =>
    both(
      `${count} invalid ${count === 1 ? 'address' : 'addresses'} ignored in the configuration (an IPv4 address, with an optional port).`,
      `${count} ${count === 1 ? 'adresse invalide ignorée' : 'adresses invalides ignorées'} dans la configuration (une adresse IPv4, avec un port facultatif).`,
    ),
  configUnread: both(
    'The configuration could not be read from Gladys: asked again at spaced intervals; meanwhile the devices already created stay controlled, with the last volume cap known.',
    "La configuration n'a pas pu être lue depuis Gladys : redemandée à intervalles espacés ; en attendant, les appareils déjà créés restent pilotés, avec le dernier plafond de volume connu.",
  ),
  dataReset: both(
    'The saved device list was unreadable and was reset (kept aside as anthem.json.bad); the devices are found again from their addresses.',
    'La liste enregistrée des appareils était illisible et a été réinitialisée (gardée à part dans anthem.json.bad) ; les appareils sont retrouvés par leurs adresses.',
  ),
  dataUnreadable: both(
    'The saved data (/data) cannot be read: read again every few seconds, nothing written over it meanwhile.',
    'Les données enregistrées (/data) ne peuvent pas être lues : relues toutes les quelques secondes, rien n’est écrit par-dessus en attendant.',
  ),
};
