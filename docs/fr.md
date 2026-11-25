# Anthem pour Gladys Assistant

Pilotez vos amplis-tuners et processeurs audio-vidéo Anthem depuis Gladys, sur
votre réseau local, sans aucun cloud : marche, volume, sourdine et source de la
zone principale et de la zone 2.

> Intégration non officielle, sans lien avec Anthem. Elle suit la fiche
> officielle de contrôle IP d'Anthem (« MRX x40, AVM 70/90 IP & RS-232 » v5)
> mais n'a **jamais été testée avec un vrai appareil** : vos retours sont les
> bienvenus.

## Appareils pris en charge

Les modèles de la fiche officielle : amplis-tuners **MRX 540, MRX 740,
MRX 1140** et processeurs **AVM 70, AVM 90**. La zone 2 apparaît quand
l'appareil répond pour elle (MRX 740, MRX 1140, AVM 70, AVM 90).

D'autres modèles Anthem avec contrôle IP (anciens MRX x20 et x10, AVM 60, STR,
MDX) peuvent répondre à une partie des commandes : marche, sourdine et source
peuvent fonctionner ; le volume demande l'échelle en pour cent des modèles
x40, il reste donc inconnu sur les autres et retirer la sourdine depuis Gladys
est alors refusé (le plafond de volume ne peut pas être vérifié).

## Préparer l'appareil

1. Branchez l'appareil sur votre réseau (Ethernet ou Wi-Fi).
2. Dans son menu de configuration, activez le **contrôle IP en veille**
   (aussi appelé veille connectée) : sans lui, l'appareil n'est pas joignable
   quand il est éteint, et Gladys ne peut pas l'allumer.
3. Donnez-lui une **adresse IP fixe** dans votre box (réservation DHCP).
4. Le port du contrôle IP est **14999**, sauf si vous avez changé « TCP Port ».

L'appareil accepte un nombre limité de clients IP à la fois et ferme le plus
ancien quand un nouveau arrive : si l'application Anthem ou une autre
domotique est aussi connectée, les connexions peuvent se chasser l'une
l'autre. Gladys se reconnecte alors à intervalles espacés (10 s, doublés
jusqu'à 5 minutes).

## Configurer l'intégration

- **Adresses IP des appareils** : séparées par des virgules, par exemple
  `192.168.1.40, 192.168.1.41`, avec le port s'il n'est pas 14999
  (`192.168.1.40:15000`).
- **Plafond de volume** (1 à 100 %, 40 par défaut) : le volume le plus fort
  que Gladys peut régler, sur l'échelle en pour cent de l'appareil (30 %
  correspond à -25 dB, 40 % à -20 dB, chaque pour cent au-dessus de 30 ajoute
  0,5 dB ; 100 % correspond à +10 dB). 100 : pas de plafond.

Chaque zone apparaît ensuite dans l'onglet **Découverte** : créez celles que
vous voulez. Le bouton **Vérifier les appareils** affiche l'état de chaque
zone et le plafond.

## Ce que vous obtenez, pour chaque zone

| Fonction  | Genre               | Ce qu'elle fait                                                       |
| --------- | ------------------- | --------------------------------------------------------------------- |
| Power     | lecture seule (0/1) | 1 quand la zone est allumée, 0 éteinte ou appareil injoignable        |
| Power on  | bouton              | allume la zone, puis ramène son volume au plafond s'il est au-dessus  |
| Power off | bouton              | éteint la zone (protectrice : voir plus bas)                          |
| Volume    | 0 à 100 %           | règle le volume, jamais au-dessus du plafond                          |
| Muted     | lecture seule (0/1) | 1 quand la zone est en sourdine                                       |
| Mute      | bouton              | coupe le son de la zone (protectrice : voir plus bas)                 |
| Unmute    | bouton              | retire la sourdine, après avoir baissé un volume au-dessus du plafond |
| Source    | liste               | les entrées de l'appareil, par leur nom                               |

Il n'y a volontairement pas d'interrupteur marche/arrêt : un « tout éteindre »
ou « tout allumer » d'une scène ou d'un assistant vocal n'allume jamais un
ampli.

Les états sont lus quand une zone change (quand l'appareil le signale) et
toutes les 30 secondes. Une commande n'est dite réussie que si une lecture
faite après elle montre la valeur demandée ; sinon Gladys indique « envoyée,
sans confirmation » ou « envoyée, pas encore appliquée », et la zone est
relue 5 et 20 secondes plus tard.

### Le plafond de volume

Tout volume réglé depuis Gladys (tableau de bord, scène, assistant vocal)
passe par le plafond, lu juste avant l'envoi de la commande : une valeur plus
forte est ramenée au plafond. Retirer la sourdine lit d'abord le volume et le
baisse au plafond s'il est au-dessus, puis ne retire la sourdine qu'une fois
qu'une lecture le montre au plafond ou en dessous ; si le volume ne peut pas
être lu, rien n'est envoyé. Après un **Power on** depuis Gladys, le volume est relu toutes les quelques secondes jusqu'à ce que la zone le donne (dans les 2 minutes) et baissé au plafond s'il est au-dessus.
Le volume réglé sur l'appareil lui-même (bouton, télécommande, application
Anthem) n'est pas modifié autrement.

### Éteindre et Couper le son ne sont jamais bloqués

Power off et Mute n'attendent pas derrière les autres commandes de la zone
(celles encore en attente sont annulées : rien de demandé avant ne part après
elles), passent en premier sur la connexion (au plus derrière la seule requête
en cours, 1 seconde au plus), et ne dépendent ni du plafond de volume, ni de la
configuration (même si Gladys ne peut pas la donner), ni d'une lecture d'état
préalable, ni d'une file de requêtes pleine.

Elles ne partent pas, ou ne sont pas confirmées, dans ces seuls cas :

- **l'appareil n'est pas connecté** : une connexion est demandée aussitôt
  (quel que soit le délai de reconnexion, au plus toutes les 2 secondes), la
  commande réessayée toutes les 250 ms pendant environ 3 secondes, puis
  gardée (même après un redémarrage de l'intégration) et envoyée dès que la
  connexion revient. Elle n'est abandonnée après 2 minutes qu'une fois une
  connexion tentée après ces 2 minutes et échouée ; une commande déjà partie
  n'est plus renvoyée après 2 minutes. Power off et Mute sont gardées à part :
  appuyer sur l'une n'annule jamais l'autre. Tant qu'elle est gardée, Gladys
  la signale comme non faite ;
- **l'appareil les refuse** (une réponse d'erreur) : signalées comme refusées ;
- **Mute sur une zone éteinte** (ou un appareil en veille) : rien ne joue,
  signalé comme fait ;
- **pas de confirmation dans les 5 secondes qu'attend Gladys** : signalées
  « envoyée, sans confirmation ».

Tant qu'elles ne sont pas confirmées, elles sont renvoyées (3 envois au plus,
dans les 2 minutes) quand une lecture faite après elles montre encore la zone
allumée (ou sans sourdine) ; un changement que l'appareil signale de lui-même
(télécommande, application) ne les fait jamais renvoyer. Un Power on parti
depuis Gladys arrête ce renvoi pour Power off, un Unmute parti depuis Gladys
l'arrête pour Mute.

## En cas de souci

- **« Aucun appareil Anthem ne répond encore »** : vérifiez l'adresse, le port,
  que le contrôle IP en veille est activé, et que rien ne bloque le port 14999.
- **Non connecté quand l'appareil est éteint** : le contrôle IP en veille est
  désactivé.
- **Le volume reste inconnu** : le modèle n'a pas d'échelle de volume en pour
  cent (voir Appareils pris en charge).
- **Une source manque** : les entrées sont lues quand une zone est allumée ;
  allumez-la une fois.

## Vie privée

Tout reste sur votre réseau local. L'intégration garde dans `/data` les
appareils trouvés (adresse, modèle, zones, noms des entrées), le dernier
plafond de volume, et les commandes Power off / Mute pas encore confirmées.
Aucun compte, aucun mot de passe, aucun cloud.
