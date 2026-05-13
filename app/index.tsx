import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ScrollView, Dimensions, Alert, PanResponder, Animated } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import * as Location from 'expo-location';
import { LineChart, PieChart, BarChart } from "react-native-gifted-charts";
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as DocumentPicker from 'expo-document-picker';


interface SensorData {
  roll: number;
  pitch: number;
  yaw: number;
  accel: number;
  speed: number; // Vitesse GPS en km/h
  timeSec: number;
  timestamp?: number;
}

interface SavedSession {
  id: string;
  date: string;
  chrono: number;
  data: SensorData[];
}

export default function App() {
  const [data, setData] = useState<SensorData[]>([]);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [motionSub, setMotionSub] = useState<any>(null);
  const [locationSub, setLocationSub] = useState<any>(null);
  const [chrono, setChrono] = useState<number>(0);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'analysis' | 'history'>('dashboard');
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sliderIndex, setSliderIndex] = useState<number>(0);

  // --- MÉMOIRE DE CALIBRAGE (TARE) ---
  const [offsetRoll, setOffsetRoll] = useState<number>(0);
  const [offsetPitch, setOffsetPitch] = useState<number>(0);
  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);

  // --- GESTION DU ROTOR TACTILE HAUTE PRÉCISION ---
  const dataLenRef = React.useRef(0);
  const lastPanX = React.useRef(0);

  useEffect(() => {
    dataLenRef.current = data.length;
  }, [data]);

  const rotorResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { lastPanX.current = 0; }, // Réinitialise à chaque fois qu'on pose le doigt
      onPanResponderMove: (evt, gestureState) => {
        const sensitivity = 4; // Sensibilité : 4 pixels de glissé de doigt = 1 point (0.1 seconde). Augmente ce chiffre pour un rotor plus "dur".
        const diff = gestureState.dx - lastPanX.current;

        if (Math.abs(diff) >= sensitivity) {
          const steps = Math.trunc(diff / sensitivity);
          setSliderIndex(prev => {
            const maxIdx = Math.max(0, dataLenRef.current - 1);
            let next = prev + steps;
            if (next < 0) next = 0;
            if (next > maxIdx) next = maxIdx;
            return next;
          });
          lastPanX.current += steps * sensitivity;
        }
      },
    })
  ).current;

  useEffect(() => {
    loadSessionsFromStorage();
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isRecording) {
      interval = setInterval(() => setChrono(c => c + 1), 1000);
    } else {
      setChrono(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // --- CALIBRAGE DES CAPTEURS PRO (TARE PAR MOYENNE) ---
  const calibrateSensors = () => {
    setIsCalibrating(true);
    DeviceMotion.setUpdateInterval(100); // 10 relevés par seconde

    let samples: { gamma: number, beta: number }[] = [];
    let calibSub: any = null;

    // 1. On lance l'écoute continue
    calibSub = DeviceMotion.addListener((motionData) => {
      const gamma = motionData.rotation?.gamma ?? 0;
      const beta = motionData.rotation?.beta ?? 0;
      samples.push({ gamma, beta });
    });

    // 2. On laisse le capteur acquérir des données pendant 1.5 seconde
    setTimeout(() => {
      if (calibSub) calibSub.remove(); // On coupe le capteur

      if (samples.length > 0) {
        // 3. On jette les 3 premières valeurs (les "fantômes" du réveil du capteur)
        const validSamples = samples.length > 3 ? samples.slice(3) : samples;

        // 4. On fait la moyenne des valeurs restantes pour une précision absolue
        const sumGamma = validSamples.reduce((acc, val) => acc + val.gamma, 0);
        const sumBeta = validSamples.reduce((acc, val) => acc + val.beta, 0);

        const avgGamma = sumGamma / validSamples.length;
        const avgBeta = sumBeta / validSamples.length;

        // 5. Conversion en degrés
        const rawRoll = avgGamma * (180 / Math.PI);
        const rawPitch = avgBeta * (180 / Math.PI);

        setOffsetRoll(rawRoll);
        setOffsetPitch(rawPitch);

        setIsCalibrating(false);
        Alert.alert(
          "Bateau Calibré 📐",
          `Zéro stabilisé sur ${validSamples.length} mesures :\nGîte: ${rawRoll.toFixed(1)}° | Assiette: ${rawPitch.toFixed(1)}°`
        );
      } else {
        setIsCalibrating(false);
        Alert.alert("Erreur", "Le capteur n'a rien renvoyé.");
      }
    }, 1500); // Temps d'attente : 1,5 seconde
  };

  // --- ACQUISITION MULTI-CAPTEURS (IMU + GPS) ---
  const startRun = async () => {
    // 1. Demande de permission GPS
    let { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Erreur', 'Le GPS est nécessaire pour la vitesse.');
      return;
    }

    // 2. On lance l'interface d'enregistrement immédiatement
    setIsRecording(true);
    setActiveTab('dashboard');
    setData([]);
    setSliderIndex(0);

    // Verrouillage de l'écran (sans bloquer le code)
    setIsLocked(true);
    activateKeepAwakeAsync();

    DeviceMotion.setUpdateInterval(100);

    const startTime = Date.now();
    let currentSpeed = 0;

    // 3. Suivi GPS (Lancé en arrière-plan avec .then au lieu de await)
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 500 },
      (loc) => { currentSpeed = (loc.coords.speed ?? 0) * 3.6; }
    ).then(locSub => {
      setLocationSub(locSub);
    });

    // 4. Suivi Inertiel (DÉMARRE IMMÉDIATEMENT)
    const mSub = DeviceMotion.addListener((motionData) => {
      const accelY = motionData.acceleration?.y ?? 0;
      const gamma = motionData.rotation?.gamma ?? 0;
      const beta = motionData.rotation?.beta ?? 0;

      const now = Date.now();
      const elapsedSec = (now - startTime) / 1000;

      // 1. On repasse tout en VRAIS degrés
      const rawRoll = gamma * (180 / Math.PI);
      const rawPitch = beta * (180 / Math.PI);

      // 2. On applique ton inclinaison de départ (la tare)
      const finalRoll = rawRoll - offsetRoll;
      const finalPitch = rawPitch - offsetPitch;

      const newData: SensorData = {
        roll: parseFloat(finalRoll.toFixed(1)),
        pitch: parseFloat(finalPitch.toFixed(1)),
        yaw: 0,
        accel: parseFloat(accelY.toFixed(2)),
        speed: parseFloat(currentSpeed.toFixed(1)),
        timeSec: elapsedSec,
        timestamp: now
      };

      setData(prev => [...prev, newData]);
    });

    setMotionSub(mSub);
  };

  const stopRun = async () => {
    deactivateKeepAwake(); // Le téléphone peut à nouveau se reposer
    setIsLocked(false);
    if (motionSub) motionSub.remove();
    if (locationSub) locationSub.remove();
    setMotionSub(null);
    setLocationSub(null);
    setIsRecording(false);
    setActiveTab('analysis');
  };

  const unlockScreen = () => {
    setIsLocked(false);
  };
  // --- MÉCANIQUE DU CADENAS GLISSANT (SLIDER ANTI-EAU) ---
  const slideAnim = React.useRef(new Animated.Value(0)).current;
  const SLIDE_MAX = screenWidth - 100; // Longueur de la piste de glisse

  const unlockResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => {
        // Le cadenas suit le doigt vers la droite
        if (gestureState.dx > 0 && gestureState.dx < SLIDE_MAX - 60) {
          slideAnim.setValue(gestureState.dx);
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dx >= SLIDE_MAX - 80) {
          // Si on a glissé jusqu'au bout : Déverrouillé !
          unlockScreen();
          slideAnim.setValue(0);
        } else {
          // Sinon : Effet ressort, le cadenas retourne à zéro
          Animated.spring(slideAnim, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      }
    })
  ).current;

  // --- SAUVEGARDE LOCALE ---
  const loadSessionsFromStorage = async () => {
    try {
      const jsonValue = await AsyncStorage.getItem('@kayak_runs');
      if (jsonValue != null) setSavedSessions(JSON.parse(jsonValue));
    } catch (e) { console.log(e); }
  };

  const saveCurrentSession = async () => {
    if (data.length === 0) return;
    const newSession: SavedSession = {
      id: Date.now().toString(),
      date: new Date().toLocaleString('fr-FR'),
      chrono: chrono,
      data: [...data]
    };
    const updatedSessions = [newSession, ...savedSessions];
    setSavedSessions(updatedSessions);
    try {
      await AsyncStorage.setItem('@kayak_runs', JSON.stringify(updatedSessions));
      Alert.alert("Sauvegardé", "Le run est dans l'historique.");
    } catch (e) { Alert.alert("Erreur", "Sauvegarde impossible."); }
  };

  const loadSpecificSession = (session: SavedSession) => {
    setData(session.data);
    setChrono(session.chrono);
    setSliderIndex(0);
    setActiveTab('analysis');
  };

  const deleteSession = async (id: string) => {
    const filtered = savedSessions.filter(s => s.id !== id);
    setSavedSessions(filtered);
    await AsyncStorage.setItem('@kayak_runs', JSON.stringify(filtered));
  };

  // --- MOTEUR D'EXPORT PDF (Graphes SVG inclus) ---
  const sanitize = (val: any) => { const n = Number(val); return isNaN(n) ? 0 : n; };
  const generateLineSVG = (dataArray: number[], timesArray: number[], color: string, unit: string) => {
    if (dataArray.length < 2) return '';
    const width = 800; const height = 200; const padX = 50; const padY = 30;
    const graphW = width - padX - 10; const graphH = height - padY * 2;
    const minVal = Math.floor(Math.min(...dataArray) - 5);
    const maxVal = Math.ceil(Math.max(...dataArray) + 5);
    const rangeY = maxVal - minVal === 0 ? 1 : maxVal - minVal;
    const maxTime = timesArray[timesArray.length - 1];
    const points = dataArray.map((val, i) => {
      const x = padX + (timesArray[i] / maxTime) * graphW;
      const y = padY + graphH - ((val - minVal) / rangeY) * graphH;
      return `${x},${y}`;
    }).join(' ');
    const zeroY = padY + graphH - ((0 - minVal) / rangeY) * graphH;
    const zeroLine = (minVal < 0 && maxVal > 0) ? `<line x1="${padX}" y1="${zeroY}" x2="${width - 10}" y2="${zeroY}" stroke="#666" stroke-dasharray="5,5" stroke-width="1" />` : '';
    return `<svg viewBox="0 0 ${width} ${height}" style="background: #1e1e1e; border-radius: 8px; width: 100%;"><text x="${padX - 10}" y="${padY + 5}" fill="#aaa" font-size="12" text-anchor="end">${maxVal}${unit}</text><text x="${padX - 10}" y="${height - padY + 5}" fill="#aaa" font-size="12" text-anchor="end">${minVal}${unit}</text>${zeroLine}<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" points="${points}" /></svg>`;
  };

  // --- EXPORT DES DONNÉES BRUTES POUR SYNCHRONISATION VIDÉO (CSV) ---
  const exportCSV = async () => {
    if (data.length === 0) {
      Alert.alert("Vide", "Aucune donnée à exporter.");
      return;
    }

    try {
      // 1. Création de l'en-tête (avec l'Heure Absolue au format international)
      let csvString = "AbsoluteTime,ElapsedTime(s),Roll(deg),Pitch(deg),Acceleration(m/s2),Speed(km/h)\n";

      // 2. Écriture sécurisée
      data.forEach(d => {
        // Conversion de l'heure en format lisible par les logiciels vidéo (ex: 2026-04-07T14:30:00.000Z)
        const absTime = d.timestamp ? new Date(d.timestamp).toISOString() : new Date().toISOString();
        const t = d.timeSec ? d.timeSec.toFixed(2) : "0.00";
        const r = d.roll ?? 0;
        const p = d.pitch ?? 0;
        const a = d.accel ?? 0;
        const s = d.speed ?? 0;

        csvString += `${absTime},${t},${r},${p},${a},${s}\n`;
      });

      // 3. Vérification du système de fichiers
      if (!FileSystem.documentDirectory) {
        throw new Error("Le dossier système du téléphone est inaccessible.");
      }

      const fileUri = FileSystem.documentDirectory + `Run_Slalom_${Date.now()}.csv`;

      // 4. Création du fichier
      await FileSystem.writeAsStringAsync(fileUri, csvString, {
        encoding: FileSystem.EncodingType.UTF8
      });

      // 5. Partage forcé avec les bons "Passeports" (MIME Type et UTI)
      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Exporter les données de télémétrie',
        UTI: 'public.comma-separated-values' // Très important pour les iPhone
      });

    } catch (error: any) {
      // SI ÇA PLANTE, LE TÉLÉPHONE VA NOUS AFFICHER LA VRAIE ERREUR
      Alert.alert("Erreur détaillée", error.message || String(error));
    }
  };

  // --- IMPORTATION D'UNE SÉANCE ATHLÈTE (CSV) ---
  const importSession = async () => {
    try {
      // 1. Ouvre l'explorateur de fichiers du téléphone
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', '*/*'], // Accepte les CSV
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return; // L'utilisateur a annulé
      }

      const fileUri = result.assets[0].uri;

      // 2. Lecture du fichier brut
      const fileContent = await FileSystem.readAsStringAsync(fileUri, { 
        encoding: FileSystem.EncodingType.UTF8 
      });

      // 3. Découpage des lignes
      const lines = fileContent.split('\n').filter(line => line.trim().length > 0);
      
      // On vérifie que c'est bien notre format (il doit y avoir au moins l'en-tête et une ligne)
      if (lines.length < 2 || !lines[0].includes('Roll(deg)')) {
        Alert.alert("Format invalide", "Ce fichier ne semble pas être un export Slalom Perf valide.");
        return;
      }

      // 4. Traduction et COMPRESSION (Downsampling pour éviter les crashs)
      const importedData: SensorData[] = [];
      
      // On fixe une limite de sécurité pour le graphique (ex: 800 points max)
      const MAX_POINTS = 800;
      // On calcule l'écart nécessaire. Si on a 8000 lignes, on ne prendra qu'1 ligne sur 10.
      const step = Math.max(1, Math.floor((lines.length - 1) / MAX_POINTS));

      // On boucle en sautant des lignes (i += step)
      for (let i = 1; i < lines.length; i += step) {
        const columns = lines[i].split(',');
        if (columns.length >= 6) {
          importedData.push({
            timestamp: new Date(columns[0]).getTime(),
            timeSec: parseFloat(columns[1]),
            roll: parseFloat(columns[2]),
            pitch: parseFloat(columns[3]),
            accel: parseFloat(columns[4]),
            speed: parseFloat(columns[5]),
            yaw: 0
          });
        }
      }

      // 5. Chargement des données dans l'application
      setData(importedData);
      setChrono(importedData[importedData.length - 1].timeSec); // Met à jour le chrono total
      setActiveTab('analysis'); // Bascule automatiquement sur l'écran des graphiques !
      setSliderIndex(0);
      
      Alert.alert("Succès", `Séance importée ! (${importedData.length} points de données)`);

    } catch (error) {
      Alert.alert("Erreur", "Impossible de lire ce fichier.");
      console.error(error);
    }
  };

  const exportPDF = async () => {
    const times = data.map(d => sanitize(d.timeSec));
    const rolls = data.map(d => sanitize(d.roll));
    const pitches = data.map(d => sanitize(d.pitch));
    const accels = data.map(d => sanitize(d.accel));
    const speeds = data.map(d => sanitize(d.speed));

    // Calculs pour le résumé PDF
    const thresholdMs2 = 1.5;
    const accelCount = data.filter(d => d.accel > thresholdMs2).length;
    const decelCount = data.filter(d => d.accel < -thresholdMs2).length;
    const glideRatio = Math.round((Math.max(0, data.length - accelCount - decelCount) / (data.length || 1)) * 100);

    const htmlContent = `
      <html>
        <head><style>body { font-family: sans-serif; background: #121212; color: #fff; padding: 20px; } h1 { color: #00d4ff; text-align: center; } .box { background: #1a1a1a; padding: 15px; border-radius: 10px; margin-bottom: 25px; border: 1px solid #333; } h2 { font-size: 14px; color: #aaa; margin-top: 0; }</style></head>
        <body>
          <h1>RAPPORT SLALOM HAUTE PERF</h1>
          <p style="text-align: center; color: #888;">Temps : ${formatTime(chrono)} | Vitesse Max : ${Math.max(...speeds)} km/h</p>
          
          <div class="box">
            <h2>MÉTRIQUES CLÉS DE LA MANCHE</h2>
            <ul style="line-height: 1.8;">
              <li><strong>Temps passé en glisse pure :</strong> <span style="color:#bfd200">${glideRatio}%</span> de la manche</li>
              <li><strong>Nombre de relances massives (>1.5m/s²) :</strong> ${accelCount}</li>
              <li><strong>Amplitude de gîte max :</strong> Gauche ${rolls.length ? Math.min(...rolls) : 0}° | Droite ${rolls.length ? Math.max(...rolls) : 0}°</li>
              <li><strong>Pic d'accélération (meilleure relance) :</strong> ${accels.length ? Math.max(...accels) : 0} m/s²</li>
            </ul>
          </div>

          <div class="box"><h2>GÎTE / ROULIS (°)</h2>${generateLineSVG(rolls, times, '#00d4ff', '°')}</div>
          <div class="box"><h2>ASSIETTE / TANGAGE (°)</h2>${generateLineSVG(pitches, times, '#ff9f1c', '°')}</div>
          <div class="box"><h2>VITESSE (km/h)</h2>${generateLineSVG(speeds, times, '#e0aaff', 'km/h')}</div>
          <div class="box"><h2>ACCÉLÉRATION (m/s²)</h2>${generateLineSVG(accels, times, '#bfd200', 'm/s²')}</div>
        </body>
      </html>
    `;
    const { uri } = await Print.printToFileAsync({ html: htmlContent });
    await Sharing.shareAsync(uri);
  };

  // --- TRAITEMENT DES DONNÉES ÉCRAN ---
  const CHART_LIVE_POINTS = 50;
  const recentData = data.slice(-CHART_LIVE_POINTS);
  const paddedLive = [...Array(Math.max(0, CHART_LIVE_POINTS - recentData.length)).fill({ roll: 0, pitch: 0, accel: 0, speed: 0, timeSec: 0 }), ...recentData];
  const liveVals = data.length > 0 ? data[data.length - 1] : { roll: 0, pitch: 0, accel: 0, speed: 0, timeSec: 0 };
  const mapLive = (key: keyof SensorData) => paddedLive.map((d) => ({ value: sanitize(d[key]) }));

  // Pour l'analyse complète (AVEC TEMPS INTÉGRÉ POUR LA BULLE)
  const fullData = (key: keyof SensorData) => data.map((d, index) => ({
    value: sanitize(d[key]),
    timeExact: d.timeSec.toFixed(1), // On sauvegarde le temps exact pour la bulle tactile
    label: index % 10 === 0 ? `${d.timeSec.toFixed(0)}s` : '', // Graduation EXACTEMENT toutes les 1 secondes
    labelTextStyle: { color: '#666', fontSize: 10 }
  }));

  const activePoint = data.length > 0 ? data[sliderIndex] : { roll: 0, pitch: 0, accel: 0, speed: 0, timeSec: 0 };

  // --- CALCUL DES CAMEMBERTS (AVEC POURCENTAGES) ---
  const totalPoints = data.length || 1; // Évite la division par zéro

  // Camembert Gîte
  const leftCount = data.filter(d => d.roll < -15).length;
  const rightCount = data.filter(d => d.roll > 15).length;
  const flatCount = data.length - leftCount - rightCount;

  const pieData = [
    { value: leftCount, color: '#00d4ff', text: leftCount > 0 ? `${Math.round((leftCount / totalPoints) * 100)}%` : '' },
    { value: flatCount, color: '#666', text: flatCount > 0 ? `${Math.round((flatCount / totalPoints) * 100)}%` : '' },
    { value: rightCount, color: '#ff0054', text: rightCount > 0 ? `${Math.round((rightCount / totalPoints) * 100)}%` : '' }
  ];

  // Camembert Accélération
  const thresholdMs2 = 1.5;
  const accelCount = data.filter(d => d.accel > thresholdMs2).length;
  const decelCount = data.filter(d => d.accel < -thresholdMs2).length;
  const glideCount = Math.max(0, data.length - accelCount - decelCount);

  const accelPieData = [
    { value: accelCount > 0 ? accelCount : 1, color: '#bfd200', text: accelCount > 0 ? `${Math.round((accelCount / totalPoints) * 100)}%` : '' },
    { value: glideCount > 0 ? glideCount : 1, color: '#666', text: glideCount > 0 ? `${Math.round((glideCount / totalPoints) * 100)}%` : '' },
    { value: decelCount > 0 ? decelCount : 1, color: '#ff4d4d', text: decelCount > 0 ? `${Math.round((decelCount / totalPoints) * 100)}%` : '' }
  ];
  // --- CALCUL DU TEMPS DE RÉACTIVITÉ (CHOC/FREINAGE ➔ RELANCE) ---
  const transitions = [];
  let currentDecelTime = null;

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    // 1. Détection d'un freinage/choc (décélération)
    if (d.accel <= -thresholdMs2 && currentDecelTime === null) {
      currentDecelTime = d.timeSec;
    }
    // 2. Dès qu'on repasse en franche accélération (relance)
    else if (d.accel >= thresholdMs2 && currentDecelTime !== null) {
      const reactionTime = d.timeSec - currentDecelTime;
      // On filtre les valeurs aberrantes (ex: pause de 5 secondes sur le bord du bassin)
      if (reactionTime > 0 && reactionTime < 5) {
        transitions.push({
          value: parseFloat(reactionTime.toFixed(2)),
          label: `#${transitions.length + 1}`,
          // Code couleur visuel selon ta vitesse de réaction
          frontColor: reactionTime < 0.5 ? '#bfd200' : (reactionTime < 1.0 ? '#ff9f1c' : '#ff4d4d')
        });
      }
      currentDecelTime = null; // On réinitialise pour le prochain passage
    }
  }
  const barData = transitions.length > 0 ? transitions : [{ value: 0, label: '-' }];

  // --- CONFIGURATION DU CURSEUR TACTILE ---
  const customPointerConfig = {
    pointerStripHeight: 120,
    pointerStripColor: '#fff',
    pointerStripWidth: 2,
    pointerColor: '#fff',
    radius: 4,
    pointerLabelWidth: 60,
    pointerLabelHeight: 35, // On agrandit un peu la bulle
    activatePointersOnLongPress: false,
    autoAdjustPointerLabelPosition: true,
    shiftPointerLabelX: -30,
    shiftPointerLabelY: 30,
    pointerLabelComponent: (items: any) => {
      return (
        <View style={{
          backgroundColor: '#1e1e1e',
          paddingVertical: 4,
          paddingHorizontal: 8,
          borderRadius: 6,
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: '#00d4ff',
          shadowColor: '#000',
          elevation: 5
        }}>
          {/* AFFICHAGE DU TEMPS EXACT */}
          <Text style={{ color: '#aaa', fontSize: 9 }}>{items[0].timeExact} s</Text>
          {/* AFFICHAGE DE LA VALEUR */}
          <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12 }}>{items[0].value}</Text>
        </View>
      );
    },
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>TÉLÉMÉTRIE SLALOM GPS</Text>
        <Text style={styles.timer}>{formatTime(chrono)}</Text>

        <View style={styles.tabContainer}>
          <TouchableOpacity style={[styles.tabButton, activeTab === 'dashboard' ? styles.tabActive : null]} onPress={() => setActiveTab('dashboard')}>
            <Text style={[styles.tabText, activeTab === 'dashboard' ? styles.tabTextActive : null]}>🔴 DIRECT</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tabButton, activeTab === 'analysis' ? styles.tabActive : null]} onPress={() => setActiveTab('analysis')}>
            <Text style={[styles.tabText, activeTab === 'analysis' ? styles.tabTextActive : null]}>⏱️ ANALYSE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tabButton, activeTab === 'history' ? styles.tabActive : null]} onPress={() => setActiveTab('history')}>
            <Text style={[styles.tabText, activeTab === 'history' ? styles.tabTextActive : null]}>💾 HISTO</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>

        {/* --- VUE 1 : DIRECT --- */}
        {activeTab === 'dashboard' ? (
          <>
            <View style={styles.speedBox}>
              <Text style={styles.speedLabel}>VITESSE GPS</Text>
              <Text style={styles.speedValue}>{liveVals.speed} <Text style={{ fontSize: 20 }}>km/h</Text></Text>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}><Text style={styles.cardTitle}>GÎTE / ROULIS (°)</Text><Text style={[styles.currentValue, { color: '#00d4ff' }]}>{liveVals.roll}°</Text></View>
              <LineChart data={mapLive('roll')} maxValue={90} mostNegativeValue={-90} height={70} width={screenWidth - 80} color="#00d4ff" thickness={2} hideDataPoints yAxisTextStyle={{ color: '#666', fontSize: 10 }} rulesColor="#333" spacing={(screenWidth - 80) / CHART_LIVE_POINTS} />
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}><Text style={styles.cardTitle}>ASSIETTE / TANGAGE (°)</Text><Text style={[styles.currentValue, { color: '#ff9f1c' }]}>{liveVals.pitch}°</Text></View>
              <LineChart data={mapLive('pitch')} maxValue={90} mostNegativeValue={-90} height={70} width={screenWidth - 80} color="#ff9f1c" thickness={2} hideDataPoints yAxisTextStyle={{ color: '#666', fontSize: 10 }} rulesColor="#333" spacing={(screenWidth - 80) / CHART_LIVE_POINTS} />
            </View>
          </>
        ) : null}

        {/* --- VUE 2 : ANALYSE HAUTE PERF --- */}
        {activeTab === 'analysis' ? (
          <>
            {data.length === 0 ? <Text style={styles.instructionText}>Aucune donnée.</Text> : (
              <View style={{ width: '100%', alignItems: 'center' }}>

                {/* 1. LA MOLETTE ET LE SCHÉMA DU BATEAU */}
                <View style={styles.interactiveBox}>
                  <Text style={styles.sliderTime}>Instant : {activePoint.timeSec.toFixed(1)} s</Text>

                  {/* SCHÉMAS DU BATEAU ANIMÉS */}
                  <View style={styles.schemasContainer}>
                    {/* Vue Arrière (Gîte) */}
                    <View style={styles.schemaItem}>
                      <Text style={styles.schemaLabel}>Gîte ({activePoint.roll}°)</Text>
                      <View style={[styles.boatRear, { transform: [{ rotateZ: `${activePoint.roll}deg` }] }]}>
                        <View style={styles.boatHullRear} />
                        <View style={styles.paddler} />
                      </View>
                    </View>
                    {/* Vue Profil (Assiette) */}
                    <View style={styles.schemaItem}>
                      <Text style={styles.schemaLabel}>Assiette ({activePoint.pitch}°)</Text>
                      <View style={[styles.boatSide, { transform: [{ rotateZ: `${activePoint.pitch}deg` }] }]}>
                        <View style={styles.boatHullSide} />
                      </View>
                    </View>
                  </View>

                  <View style={styles.instantMetrics}>
                    <Text style={{ color: '#e0aaff', fontWeight: 'bold' }}>Vitesse: {activePoint.speed} km/h</Text>
                    <Text style={{ color: '#bfd200', fontWeight: 'bold' }}>Accel: {activePoint.accel} m/s²</Text>
                  </View>

                  {/* --- LE ROTOR TACTILE (Mouvement relatif) --- */}
                  <View {...rotorResponder.panHandlers} style={styles.rotorContainer}>
                    <View style={styles.rotorGrip}>
                      <Text style={styles.rotorGripText}>| | | | | | | | | | | | | | | |</Text>
                    </View>
                  </View>
                  <Text style={styles.instructionText}>👉 Fais glisser ton doigt sur le rotor de gauche à droite (comme un trackpad) pour une précision au 10ème de seconde.</Text>
                  <Text style={styles.instructionText}>Glisse la molette pour animer le bateau</Text>
                </View>

                {/* 2. RÉPARTITION DE LA GÎTE (PIE CHART) */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>RÉPARTITION DE LA GÎTE (TEMPS)</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 15 }}>
                    <PieChart data={pieData} donut innerRadius={30} radius={60} showText textColor="#fff" textSize={10} fontWeight="bold" />
                    <View style={{ marginLeft: 20 }}>
                      <Text style={{ color: '#00d4ff', fontSize: 12 }}>■ Gauche (&gt;15°)</Text>
                      <Text style={{ color: '#ff0054', fontSize: 12 }}>■ Droite (&gt;15°)</Text>
                      <Text style={{ color: '#666', fontSize: 12 }}>■ À plat</Text>
                    </View>
                  </View>
                </View>

                {/* 2 BIS. RÉPARTITION DES RELANCES (PIE CHART) */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>DYNAMIQUE DE GLISSE</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 15 }}>
                    <PieChart data={accelPieData} donut innerRadius={30} radius={60} showText textColor="#fff" textSize={10} fontWeight="bold" />
                    <View style={{ marginLeft: 20 }}>
                      <Text style={{ color: '#bfd200', fontSize: 12, fontWeight: 'bold' }}>■ Relance (&gt;{thresholdMs2} m/s²)</Text>
                      <Text style={{ color: '#666', fontSize: 12 }}>■ Glisse continue</Text>
                      <Text style={{ color: '#ff4d4d', fontSize: 12, fontWeight: 'bold' }}>■ Freinage (&lt;{-thresholdMs2} m/s²)</Text>
                    </View>
                  </View>
                </View>

                {/* 2 TER. TEMPS DE RÉACTIVITÉ (BAR CHART) */}
                <View style={styles.card}>
                  <Text style={[styles.cardTitle, { color: '#fff' }]}>TEMPS DE RÉACTION (CHOC ➔ RELANCE)</Text>
                  <Text style={{ color: '#888', fontSize: 10, marginBottom: 15 }}>Temps écoulé (en secondes) entre un gros freinage et le coup de pagaie suivant. Plus c'est bas et vert, mieux c'est !</Text>

                  <ScrollView horizontal showsHorizontalScrollIndicator={true} style={{ paddingBottom: 10 }}>
                    <BarChart
                      data={barData}
                      barWidth={22}
                      spacing={20}
                      roundedTop
                      hideRules
                      xAxisThickness={1}
                      xAxisColor="#444"
                      yAxisThickness={0}
                      yAxisTextStyle={{ color: '#666', fontSize: 10 }}
                      noOfSections={4}
                      maxValue={Math.max(...barData.map(d => d.value), 2)} // Échelle dynamique
                      pointerConfig={customPointerConfig} // On garde la bulle cliquable magique !
                    />
                  </ScrollView>
                </View>

                {/* 3. GRAPHIQUES COMPLETS (INTERACTIFS) */}
                <Text style={styles.instructionText}>👉 Touche les courbes pour lire les valeurs exactes. Fais glisser pour te déplacer sur l'axe du temps.</Text>

                <View style={styles.card}>
                  <Text style={[styles.cardTitle, { color: '#e0aaff' }]}>VITESSE (km/h) - RUN COMPLET</Text>
                  <LineChart data={fullData('speed')} spacing={4} initialSpacing={0} pointerConfig={customPointerConfig} maxValue={20} mostNegativeValue={0} height={100} width={screenWidth - 80} color="#e0aaff" thickness={1.5} hideDataPoints yAxisTextStyle={{ color: '#666', fontSize: 10 }} rulesColor="#333" />
                </View>

                <View style={styles.card}>
                  <Text style={[styles.cardTitle, { color: '#00d4ff' }]}>GÎTE (°) - RUN COMPLET</Text>
                  <LineChart data={fullData('roll')} spacing={4} initialSpacing={0} pointerConfig={customPointerConfig} maxValue={90} mostNegativeValue={-90} height={100} width={screenWidth - 80} color="#00d4ff" thickness={1.5} hideDataPoints yAxisTextStyle={{ color: '#666', fontSize: 10 }} rulesColor="#333" />
                </View>

                <View style={styles.card}>
                  <Text style={[styles.cardTitle, { color: '#ff9f1c' }]}>ASSIETTE (°) - RUN COMPLET</Text>
                  <LineChart data={fullData('pitch')} spacing={4} initialSpacing={0} pointerConfig={customPointerConfig} maxValue={90} mostNegativeValue={-90} height={100} width={screenWidth - 80} color="#ff9f1c" thickness={1.5} hideDataPoints yAxisTextStyle={{ color: '#666', fontSize: 10 }} rulesColor="#333" />
                </View>

                <View style={styles.card}>
                  <Text style={[styles.cardTitle, { color: '#bfd200' }]}>ACCÉLÉRATION (m/s²) - RUN COMPLET</Text>
                  <LineChart data={fullData('accel')} spacing={4} initialSpacing={0} pointerConfig={customPointerConfig} maxValue={20} mostNegativeValue={-20} height={100} width={screenWidth - 80} color="#bfd200" thickness={1.5} hideDataPoints yAxisTextStyle={{ color: '#666', fontSize: 10 }} rulesColor="#333" />
                </View>

              </View>
            )}
          </>
        ) : null}

        {/* --- VUE 3 : HISTORIQUE --- */}
        {/* --- ONGLET HISTORIQUE & IMPORT --- */}
        {activeTab === 'history' && (
          <View style={{flex: 1, width: '100%', padding: 20}}>
            <Text style={[styles.cardTitle, {fontSize: 18, marginBottom: 15}]}>ARCHIVES & ATHLÈTES</Text>
            
            {/* NOUVEAU BOUTON D'IMPORTATION */}
            <TouchableOpacity 
              style={[styles.btn, {backgroundColor: '#e0aaff', marginBottom: 20}]} 
              onPress={importSession}
            >
              <Text style={[styles.btnText, {color: '#000'}]}>📥 IMPORTER LA SÉANCE D'UN ATHLÈTE</Text>
            </TouchableOpacity>

            {/* Le reste de ton code historique habituel (liste des runs sauvegardés, etc.) */}
            <Text style={{color: '#666'}}>Vos sessions sauvegardées apparaîtront ici...</Text>
          </View>
        )}
        {activeTab === 'history' ? (
          <View style={{ width: '92%' }}>
            {savedSessions.length === 0 ? <Text style={styles.instructionText}>Aucune sauvegarde.</Text> :
              savedSessions.map((session) => (
                <View key={session.id} style={styles.sessionCard}>
                  <View>
                    <Text style={styles.sessionDate}>{session.date}</Text>
                    <Text style={styles.sessionDetails}>Durée: {formatTime(session.chrono)} | Pts: {session.data.length}</Text>
                  </View>
                  <View style={{ flexDirection: 'row' }}>
                    <TouchableOpacity style={styles.btnLoad} onPress={() => loadSpecificSession(session)}><Text style={styles.btnTextSmall}>OUVRIR</Text></TouchableOpacity>
                    <TouchableOpacity style={styles.btnDelete} onPress={() => deleteSession(session.id)}><Text style={styles.btnTextSmall}>X</Text></TouchableOpacity>
                  </View>
                </View>
              ))
            }
          </View>
        ) : null}

      </ScrollView>

      {/* --- BOUTONS FIXES --- */}
      <View style={styles.controls}>
        {/* Actions Avant Run : Calibrer et Lancer */}
        {activeTab === 'dashboard' && !isRecording ? (
          <View style={{ flexDirection: 'row', width: '100%', paddingHorizontal: 10 }}>
            <TouchableOpacity
              style={[styles.btn, { flex: 1, marginRight: 5, backgroundColor: '#333' }]}
              onPress={calibrateSensors}
              disabled={isCalibrating}
            >
              <Text style={[styles.btnText, { fontSize: 12 }]}>{isCalibrating ? "..." : "📐 FAIRE LE ZÉRO"}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnStart, { flex: 1, marginLeft: 5 }]}
              onPress={startRun}
            >
              <View style={styles.recordCircle} />
              <Text style={[styles.btnText, { fontSize: 12 }]}>LANCER</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {activeTab === 'dashboard' && isRecording ? <TouchableOpacity style={[styles.btn, styles.btnStop]} onPress={stopRun}><View style={styles.stopSquare} /><Text style={styles.btnText}>ARRÊTER LE RUN</Text></TouchableOpacity> : null}

        {/* Actions d'Analyse (Sauvegarde, PDF, CSV) */}
        {activeTab === 'analysis' && data.length > 0 ? (
          <View style={{ flexDirection: 'column', width: '100%' }}>
            <TouchableOpacity style={[styles.btn, { backgroundColor: '#333', marginBottom: 10 }]} onPress={saveCurrentSession}>
              <Text style={styles.btnText}>💾 SAUVEGARDER DANS LE TÉLÉPHONE</Text>
            </TouchableOpacity>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <TouchableOpacity style={[styles.btn, { flex: 1, marginRight: 5, backgroundColor: '#00d4ff' }]} onPress={exportPDF}>
                <Text style={[styles.btnText, { color: '#000', fontSize: 12 }]}>📄 RAPPORT PDF</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, { flex: 1, marginLeft: 5, backgroundColor: '#bfd200' }]} onPress={exportCSV}>
                <Text style={[styles.btnText, { color: '#000', fontSize: 12 }]}>📥 DONNÉES VIDÉO (CSV)</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </View>
      {/* --- BOUTONS FIXES --- */}
      <View style={styles.controls}>
        {/* ... Tes boutons normaux sont ici ... */}
      </View>

      {/* ==================================================== */}
      {/* NOUVEAU CALQUE DE VERROUILLAGE (TRANSPARENT + SLIDER) */}
      {/* ==================================================== */}
      {isLocked && (
        <View style={styles.lockedOverlay}>
          {/* Ce calque absorbe tous les clics parasites de l'eau, mais on voit au travers ! */}

          <View style={styles.sliderTrack}>
            <Text style={styles.sliderTrackText}>GLISSER POUR DÉVERROUILLER ➔</Text>
            <Animated.View
              {...unlockResponder.panHandlers}
              style={[styles.sliderThumb, { transform: [{ translateX: slideAnim }] }]}
            >
              <Text style={{ fontSize: 24 }}>🔒</Text>
            </Animated.View>
          </View>
        </View>
      )}

    </View>
  );
}
const screenWidth = Dimensions.get('window').width;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  header: { paddingTop: 60, paddingBottom: 15, backgroundColor: '#1e1e1e', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#333' },
  title: { fontSize: 14, fontWeight: '800', color: '#888', letterSpacing: 2 },
  timer: { fontSize: 48, fontWeight: '300', color: '#fff', marginTop: 5, fontVariant: ['tabular-nums'] },

  tabContainer: { flexDirection: 'row', marginTop: 15, backgroundColor: '#2a2a2a', borderRadius: 8, padding: 4 },
  tabButton: { paddingVertical: 10, paddingHorizontal: 15, borderRadius: 6 },
  tabActive: { backgroundColor: '#444' },
  tabText: { color: '#888', fontWeight: 'bold', fontSize: 11 },
  tabTextActive: { color: '#fff' },
  instructionText: { color: '#aaa', fontStyle: 'italic', fontSize: 11, textAlign: 'center' },

  scrollArea: { flex: 1, width: '100%' },
  scrollContent: { paddingVertical: 15, alignItems: 'center' },

  card: { backgroundColor: '#1e1e1e', borderRadius: 16, padding: 15, marginBottom: 15, width: '92%', borderWidth: 1, borderColor: '#2a2a2a' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  cardTitle: { fontSize: 12, fontWeight: 'bold', color: '#888', letterSpacing: 1 },
  currentValue: { fontSize: 24, fontWeight: 'bold', fontVariant: ['tabular-nums'] },

  /* Vitesse Dashboard */
  speedBox: { backgroundColor: '#2a1b3d', padding: 20, borderRadius: 16, width: '92%', marginBottom: 15, alignItems: 'center', borderWidth: 1, borderColor: '#4a2c6d' },
  speedLabel: { color: '#e0aaff', fontSize: 12, fontWeight: 'bold', letterSpacing: 2, marginBottom: 5 },
  speedValue: { color: '#fff', fontSize: 48, fontWeight: 'bold' },

  /* Analyse Interactive (Bateau) */
  interactiveBox: { backgroundColor: '#1a1a1a', padding: 20, borderRadius: 16, width: '92%', marginBottom: 20, borderWidth: 1, borderColor: '#333', alignItems: 'center' },
  sliderTime: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginBottom: 20 },
  schemasContainer: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginBottom: 20 },
  schemaItem: { alignItems: 'center' },
  schemaLabel: { color: '#aaa', fontSize: 12, marginBottom: 15 },

  // Dessin du bateau - Vue arrière (Gîte)
  boatRear: { width: 60, height: 60, justifyContent: 'flex-end', alignItems: 'center' },
  boatHullRear: { width: 60, height: 30, backgroundColor: '#00d4ff', borderBottomLeftRadius: 30, borderBottomRightRadius: 30 },
  paddler: { width: 4, height: 30, backgroundColor: '#fff', position: 'absolute', top: 0 },

  // Dessin du bateau - Vue Profil (Assiette)
  boatSide: { width: 100, height: 60, justifyContent: 'center', alignItems: 'center' },
  boatHullSide: { width: 100, height: 15, backgroundColor: '#ff9f1c', borderRadius: 10 },

  instantMetrics: { flexDirection: 'row', justifyContent: 'space-between', width: '80%', marginVertical: 10 },
  /* Rotor Tactile */
  rotorContainer: { width: '90%', height: 60, backgroundColor: '#2a2a2a', borderRadius: 12, marginVertical: 15, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#444' },
  rotorGrip: { justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%' },
  rotorGripText: { color: '#666', fontSize: 16, letterSpacing: 2, fontWeight: 'bold' },

  /* Historique */
  sessionCard: { backgroundColor: '#1e1e1e', padding: 15, borderRadius: 10, marginBottom: 10, borderWidth: 1, borderColor: '#333', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sessionDate: { color: '#fff', fontWeight: 'bold', fontSize: 14, marginBottom: 4 },
  sessionDetails: { color: '#888', fontSize: 12 },
  btnLoad: { backgroundColor: '#2b9348', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, marginRight: 8 },
  btnDelete: { backgroundColor: '#d00000', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  btnTextSmall: { color: 'white', fontWeight: 'bold', fontSize: 10 },

  controls: { width: '100%', padding: 20, backgroundColor: '#1a1a1a', borderTopWidth: 1, borderTopColor: '#333', paddingBottom: 40 },
  btn: { padding: 18, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  btnStart: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#333' },
  btnStop: { backgroundColor: '#3a1010', borderWidth: 1, borderColor: '#ff4d4d' },
  recordCircle: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#ff4d4d', marginRight: 10 },
  stopSquare: { width: 14, height: 14, backgroundColor: '#ff4d4d', marginRight: 10, borderRadius: 2 },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 14, letterSpacing: 1 },

  /* --- Style du Calque Cadenas (Water Lock) --- */
  lockedOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 40, zIndex: 1000 },
  sliderTrack: { width: '80%', height: 65, backgroundColor: '#1a1a1a', borderRadius: 35, borderWidth: 2, borderColor: '#333', justifyContent: 'center', overflow: 'hidden' },
  sliderTrackText: { position: 'absolute', width: '100%', textAlign: 'center', color: '#888', fontWeight: 'bold', fontSize: 11, letterSpacing: 1 },
  sliderThumb: { width: 61, height: 61, backgroundColor: '#00d4ff', borderRadius: 30, justifyContent: 'center', alignItems: 'center', position: 'absolute', left: 0, zIndex: 2, shadowColor: '#000', elevation: 5 },
});
