import { Text, View } from "@react-pdf/renderer";
import { currentMode } from "@/db/client";

/** The band at the top of every page of every PDF made in training mode. Nothing outside training shows it. */
export function TrainingMark() {
  if (currentMode() !== "training") return null;
  return (
    <View fixed style={{ backgroundColor: "#fdecc8", borderColor: "#b45309", borderWidth: 1, borderStyle: "solid", padding: 4, marginBottom: 8 }}>
      <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", color: "#7c2d12", textAlign: "center" }}>TRAINING: practice data only. This is not a real record.</Text>
    </View>
  );
}
