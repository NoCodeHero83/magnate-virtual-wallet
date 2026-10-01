import React, { useState } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ScreenHeader } from '../../components/layout';
import { ProgressIndicator } from '../../components/register/ProgressIndicator';
import { StepAccountType } from '../../components/register/StepAccountType';
import { StepFormData } from '../../components/register/StepFormData';
import {
    StepCompanyData,
    CompanyFormData,
    emptyCompanyFormData,
    toISODate,
} from '../../components/register/StepCompanyData';
import { StepEmailVerification, CodeRequestInfo } from '../../components/register/StepEmailVerification';
import { StepPinCreation } from '../../components/register/StepPinCreation';
import { StepConfirmation } from '../../components/register/StepConfirmation';
import { colors } from '../../theme';
import { isTestEnv } from '../../config/environment';
import type { UserAccountType } from '../../types/database.types';
import type { CompanyRegisterData } from '../../services/auth.service';
import {
    validateEmail,
    validateDNI,
    validateCUITCUIL,
    validatePhone,
    validateName
} from '../../utils/validators';

interface FormData {
    nombres: string;
    apellidos: string;
    email: string;
    telefono: string;
    dni: string;
    cuit: string;
    zapsign_doc_token?: string;
    zapsign_contract_url?: string;
    zapsign_data?: any;
}

type StepId = 'type' | 'form' | 'company' | 'email' | 'pin' | 'confirm';

const STEP_SEQUENCES: Record<UserAccountType, StepId[]> = {
    personal: ['type', 'form', 'email', 'pin', 'confirm'],
    business: ['type', 'form', 'company', 'email', 'pin', 'confirm'],
};

const STEP_TITLES: Record<StepId, string> = {
    type: 'Crear Cuenta',
    form: 'Crear Cuenta',
    company: 'Datos de la Empresa',
    email: 'Verificar Correo',
    pin: 'PIN de Seguridad',
    confirm: 'Confirmación',
};

export default function RegisterScreen() {
    const insets = useSafeAreaInsets();
    const [accountType, setAccountType] = useState<UserAccountType | null>(null);
    const [step, setStep] = useState<StepId>('type');
    const [formData, setFormData] = useState<FormData>({
        nombres: '', apellidos: '', email: '', telefono: '+54', dni: '', cuit: '',
        // zapsign_doc_token y zapsign_contract_url se setean al firmar
    });
    const [companyData, setCompanyData] = useState<CompanyFormData>(emptyCompanyFormData);
    const [pin, setPin] = useState('');
    // Email ya verificado con código: si no cambia, no se vuelve a pedir el paso
    const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
    // Último código pedido (para no pedir otro al ir y volver entre pasos)
    const [lastCodeRequest, setLastCodeRequest] = useState<CodeRequestInfo | null>(null);

    const normalizedEmail = formData.email.trim().toLowerCase();
    const emailAlreadyVerified = !!verifiedEmail && verifiedEmail === normalizedEmail;
    const steps = STEP_SEQUENCES[accountType ?? 'personal'].filter(
        (id) => id !== 'email' || !emailAlreadyVerified || step === 'email'
    );
    const stepIndex = steps.indexOf(step);
    const isBusiness = accountType === 'business';

    const goNext = () => setStep(steps[Math.min(stepIndex + 1, steps.length - 1)]);
    const goTo = (id: StepId) => setStep(id);

    const handleChange = (field: keyof FormData, value: any) => {
        setFormData(prev => ({ ...prev, [field]: value }));
    };

    const handleCompanyChange = <K extends keyof CompanyFormData>(field: K, value: CompanyFormData[K]) => {
        setCompanyData(prev => ({ ...prev, [field]: value }));
    };

    const isCuitValid = isTestEnv ? true : validateCUITCUIL(formData.cuit);

    const isFormValid =
        validateName(formData.nombres) &&
        validateName(formData.apellidos) &&
        validateEmail(formData.email) &&
        validatePhone(formData.telefono) &&
        validateDNI(formData.dni) &&
        isCuitValid;

    const handleContinueFromForm = () => {
        if (isFormValid) goNext();
    };

    const handleEmailVerified = () => {
        setVerifiedEmail(normalizedEmail);
        goTo('pin');
    };

    // Tras un error al crear la cuenta: volver a los datos sin perder nada
    const handleRetry = () => goTo(isBusiness ? 'company' : 'form');

    const handlePinComplete = (createdPin: string) => {
        setPin(createdPin);
        goNext();
    };

    const handleBack = () => {
        if (stepIndex <= 0) {
            router.back();
        } else {
            setStep(steps[stepIndex - 1]);
        }
    };

    const company: CompanyRegisterData | undefined =
        isBusiness && companyData.incorporation_date && companyData.legal_entity_type
            ? {
                company_cuit: companyData.company_cuit,
                incorporation_date: toISODate(companyData.incorporation_date),
                legal_entity_type: companyData.legal_entity_type,
                legal_name: companyData.legal_name,
                trade_name: companyData.trade_name,
            }
            : undefined;

    const isConfirm = step === 'confirm';

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <ScreenHeader
                title={STEP_TITLES[step]}
                showBackButton={!isConfirm}
                onBack={handleBack}
                showAvatar={false}
                showMenu={false}
                centerTitle={isConfirm}
            />

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={{ flex: 1 }}
            >
                {!isConfirm && (
                    <ProgressIndicator currentStep={stepIndex + 1} totalSteps={steps.length - 1} />
                )}

                <View style={styles.content}>
                    {step === 'type' && (
                        <StepAccountType
                            value={accountType}
                            onChange={setAccountType}
                            onContinue={() => accountType && goNext()}
                        />
                    )}

                    {step === 'form' && (
                        <StepFormData
                            formData={formData}
                            onChange={handleChange}
                            onContinue={handleContinueFromForm}
                            isValid={isFormValid}
                            {...(isBusiness && {
                                title: 'Representante legal',
                                subtitle: 'Datos de la persona que abre y opera la cuenta en nombre de la empresa.',
                            })}
                        />
                    )}

                    {step === 'company' && (
                        <StepCompanyData
                            data={companyData}
                            onChange={handleCompanyChange}
                            onContinue={goNext}
                        />
                    )}

                    {step === 'email' && (
                        <StepEmailVerification
                            email={formData.email}
                            firstName={formData.nombres}
                            lastRequest={lastCodeRequest}
                            onCodeRequested={setLastCodeRequest}
                            onVerified={handleEmailVerified}
                            onChangeEmail={() => goTo('form')}
                            onGoToLogin={() => router.replace('/(auth)/login')}
                        />
                    )}

                    {step === 'pin' && (
                        <StepPinCreation
                            onComplete={handlePinComplete}
                            onBack={() => goTo('form')}
                            loading={false}
                        />
                    )}

                    {isConfirm && (
                        <StepConfirmation
                            data={formData}
                            pin={pin}
                            accountType={accountType ?? 'personal'}
                            company={company}
                            onRetry={handleRetry}
                        />
                    )}
                </View>
            </KeyboardAvoidingView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    content: {
        flex: 1,
    },
});
