# Envertech pour Gladys Assistant

Connecteur non officiel, sans lien avec Envertech. Il lit votre
micro-onduleur Envertech EVT800 sur votre réseau local, par son lien TCP
local, sans cloud et sans compte.

**Jamais testé avec un vrai appareil** : il a été construit à partir de la
bibliothèque pyenvertechevt800 (celle qu’utilise Home Assistant) et des trames
de ses tests. Le protocole n’est pas documenté par Envertech. Merci de
signaler ce que vous voyez (voir « Retours » plus bas).

## Ce que vous obtenez

Un appareil Gladys par micro-onduleur, nommé d’après son numéro de série :

| Fonction                          | Ce que c’est                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Production solaire (W)            | la puissance de toutes ses entrées ensemble ; 0 la nuit                                      |
| Index de production solaire (kWh) | un index cumulatif pour le suivi énergétique de Gladys (production par demi-heure, recettes) |
| Onduleur en ligne                 | 1 tant que l’onduleur envoie ses trames, 0 en veille (la nuit)                               |
| Tension AC (V)                    | la tension du réseau vue par l’onduleur                                                      |
| Fréquence du réseau (Hz)          | un simple nombre (Gladys n’a pas d’unité Hz)                                                 |
| Puissance de l’entrée n (W)       | la puissance de chaque entrée (un panneau chacune)                                           |
| Tension DC de l’entrée n (V)      | la tension du panneau                                                                        |
| Courant DC de l’entrée n (A)      | le courant du panneau (puissance divisée par la tension)                                     |
| Température de l’entrée n (°C)    | la température que l’onduleur donne pour cette entrée                                        |

Lecture seule : l’intégration ne fait qu’acquitter les trames de l’onduleur
(comme la bibliothèque, l’onduleur l’attend), elle n’envoie jamais de
commande. L’onduleur ne donne pas de compteur du jour ; son compteur total par
entrée n’est pas publié seul (voir « L’index d’énergie »).

## Mise en place

1. L’EVT800 doit être dans son mode « serveur TCP » (celui qu’utilise
   l’intégration Home Assistant), à l’écoute sur le port 14889. Trouvez son
   adresse IP dans votre box et donnez-lui une adresse fixe si possible.
2. Dans Gladys, ouvrez l’intégration, saisissez l’adresse (de jour : la nuit
   l’onduleur s’éteint avec ses panneaux), et enregistrez. Ajoutez `:port`
   seulement s’il n’est pas 14889.
3. Ouvrez l’onglet « Découverte » et créez l’appareil. Ses valeurs arrivent
   avec la trame suivante de l’onduleur.
4. Facultatif : saisissez la puissance crête des panneaux de cet onduleur
   (kWc). Elle borne ce que l’index d’énergie peut prendre entre deux trames
   (2 kW si vide). Ne saisissez jamais moins que la vraie puissance crête :
   dans le doute, laissez vide.

L’intégration garde une connexion ouverte et publie la dernière trame au plus
une fois par minute. Elle n’essaie jamais de se connecter plus d’une fois par
minute, quoi qui le demande (un redémarrage, un enregistrement, le bouton de
test). Le bouton « Tester la connexion » donne la dernière trame, ou fait
l’essai de connexion quand il est dû et attend la première trame.

Si un autre programme (Home Assistant par exemple) est connecté à l’onduleur
en même temps, l’onduleur peut refuser la seconde connexion : utilisez l’un
des deux. Ce refus ne se distingue pas de la nuit : de jour, l’état dit alors
« en veille » (et cite ce cas).

Le lien n’est gardé que par les trames de données de l’onduleur qui a répondu
le premier : sans aucune pendant 90 s, il est fermé et réessayé au rythme
habituel, et l’onduleur est affiché hors ligne. Les trames d’un autre numéro
de série sur la même connexion sont ignorées ; un autre onduleur à l’adresse
(une nouvelle connexion) a son propre appareil.

## La nuit

Un EVT800 est alimenté par ses panneaux : au coucher du soleil il s’arrête et
se tait. Ce n’est pas une erreur : après trois essais ratés avec une puissance
sous 20 W (ou une heure de silence quelle que soit la puissance), l’onduleur
est « en veille », ses puissances passent à 0, l’état reste vert et le dit, et
il est réessayé toutes les 5 minutes jusqu’à son réveil. L’état passe au
rouge (l’onduleur affiché hors ligne) si l’onduleur disparaît en produisant 20 W ou plus (nouveaux essais
après 1 minute, doublés jusqu’à 15 minutes), si l’adresse ne donne pas de
trames d’EVT800, ou s’il n’y a aucune trame depuis plus d’un jour.

## L’index d’énergie

Chaque entrée de l’onduleur a son propre compteur total. L’index de
production est leur somme, publiée seulement quand chaque entrée donne son
compteur (une somme partielle ressemblerait à une baisse, puis à un saut). Il
passe par une garde : il n’est jamais 0 ; un saut plus grand que ce que
permet la puissance crête depuis la dernière valeur, ou une baisse, est
retenu, affiché dans l’état de l’intégration, et pris seulement quand vous
cliquez sur « Accepter l’index retenu » dans la configuration (un saut est
alors compté d’un coup ; rien n’est compté pour une baisse, l’index repart de
là). Enregistrer la configuration n’accepte jamais rien.

Pendant une nuit qui suit une puissance faible, la référence de la garde est
redatée à chaque essai : le matin, la marge compte depuis la nuit, pas depuis
le soir, et une première trame fausse est retenue.

On ne sait pas si l’EVT800 garde ses compteurs quand il redémarre le matin.
Si tous les compteurs sont plus bas juste après une telle nuit, de pas plus
que la marge depuis le réveil, l’intégration y voit une remise à zéro :
l’index repart de sa valeur (les compteurs du soir lui sont ajoutés, comme les
intégrations Zeversolar et Imeon enchaînent leur compteur du jour). Si les
anciens compteurs reviennent dans les 3 heures, la remise à zéro est annulée
et rien n’est compté deux fois. Une baisse de jour reste retenue. Si une
baisse est quand même retenue chaque matin, ne l’acceptez pas chaque jour :
signalez-la.

Quand l’appareil gagne une entrée (mis à jour dans Découverte), l’index repart
de sa valeur : l’ancien compteur de la nouvelle entrée n’est jamais compté.

## Limites

- Un micro-onduleur par intégration ; deux entrées au plus (comme la
  bibliothèque).
- Le protocole n’est pas documenté : le sens de chaque valeur vient de la
  bibliothèque, vérifié seulement sur les trames de ses tests.
- L’intégration demande Gladys 5.2.0 ou plus récent.

## Vie privée

Rien ne sort de votre réseau : l’intégration ne parle qu’à l’adresse saisie.
Seuls le numéro de série, le nombre d’entrées, la nuit, l’état de l’index
(garde et compteurs) et les heures du dernier essai et de la dernière trame
sont gardés dans `/data`.

## Retours

Tickets et pull requests : <https://github.com/LM1LC3N7/gladys-envertech>. Si
vous avez un EVT800, les journaux de l’intégration (de jour et de nuit, numéros
de série masqués) aident beaucoup.
