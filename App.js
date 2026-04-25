import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ScrollView } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import { LineChart } from "react-native-gifted-charts";
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

export default function App() {
  const [data, setData] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [subscription, setSubscription] = useState(null);

  // 1. Démarrer l'enregistrement
  const startRun = () => {
    setIsRecording(true);
    setData([]); // Reset
    DeviceMotion.setUpdateInterval(100); // 10 relevés par seconde
    setSubscription(
      DeviceMotion.addListener(motionData => {
        const newData = {
          roll: (motionData.rotation.gamma * (180 / Math.PI)).toFixed(1),
          pitch: (motionData.rotation.beta * (180 / Math.PI)).toFixed(1),
          accel: motionData.acceleration.z.toFixed(2),
          timestamp: new Date().toLocaleTimeString()
        };
        setData(prev => [...prev, newData]);
      })
    );
  };

  // 2. Arrêter et sauvegarder
  const stopRun = async () => {
    subscription && subscription.remove();
    setSubscription(null);
    setIsRecording(false);
  };

  // 3. Générer le rapport PDF avec graphiques
  const exportPDF = async () => {
    const htmlContent = `
      <html>
        <body style="font-family: Arial;">
          <h1>Rapport de séance Slalom</h1>
          <p>Nombre de points enregistrés : ${data.length}</p>
          <h2>Analyse de la Gîte (Roulis)</h2>
          <div style="width: 100%; height: 200px; border: 1px solid black;">
            Données moyennes : ${data.slice(0,10).map(d => d.roll + '°').join(', ')}...
          </div>
        </body>
      </html>
    `;
    const { uri } = await Print.printToFileAsync({ html: htmlContent });
    await Sharing.shareAsync(uri);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Kayak Telemetry</Text>
      
      {/* Animation du graphique en temps réel */}
      <LineChart
        data={data.map(d => ({ value: parseFloat(d.roll) }))}
        height={200}
        color="#00b4d8"
        thickness={3}
        hideDataPoints
        curved
      />

      <View style={styles.controls}>
        {!isRecording ? (
          <TouchableOpacity style={styles.btnStart} onPress={startRun}>
            <Text style={{color: 'white'}}>DÉMARRER LE RUN</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.btnStop} onPress={stopRun}>
            <Text style={{color: 'white'}}>STOP</Text>
          </TouchableOpacity>
        )}
        
        {data.length > 0 && !isRecording && (
          <TouchableOpacity style={styles.btnExport} onPress={exportPDF}>
            <Text>EXPORTER PDF</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', paddingTop: 50 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  controls: { flexDirection: 'column', marginTop: 30 },
  btnStart: { backgroundColor: 'green', padding: 20, borderRadius: 10, marginBottom: 10 },
  btnStop: { backgroundColor: 'red', padding: 20, borderRadius: 10, marginBottom: 10 },
  btnExport: { backgroundColor: '#ddd', padding: 20, borderRadius: 10 },
});