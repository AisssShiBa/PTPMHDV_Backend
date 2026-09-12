package com.ptpmhdv.merchantservice.service;

import com.ptpmhdv.merchantservice.dto.MerchantActiveResponse;
import com.ptpmhdv.merchantservice.dto.MerchantResponse;
import com.ptpmhdv.merchantservice.dto.RegisterMerchantRequest;
import com.ptpmhdv.merchantservice.exception.DuplicateResourceException;
import com.ptpmhdv.merchantservice.exception.ResourceNotFoundException;
import com.ptpmhdv.merchantservice.exception.UnauthorizedException;
import com.ptpmhdv.merchantservice.model.Merchant;
import com.ptpmhdv.merchantservice.model.MerchantStatus;
import com.ptpmhdv.merchantservice.repository.MerchantRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class MerchantServiceTest {

    @Mock
    private MerchantRepository merchantRepository;

    @InjectMocks
    private MerchantServiceImpl merchantService;

    @Test
    void registerMerchant_Success() {
        RegisterMerchantRequest request = new RegisterMerchantRequest();
        request.setBusinessName("Test Store");
        request.setTaxId("123456789");

        when(merchantRepository.findByOwnerId("user-owner-1")).thenReturn(Optional.empty());
        when(merchantRepository.save(any(Merchant.class))).thenAnswer(i -> i.getArgument(0));

        MerchantResponse response = merchantService.registerMerchant(request, "user-owner-1");

        assertNotNull(response);
        assertEquals("Test Store", response.getBusinessName());
        assertEquals(MerchantStatus.PENDING, response.getStatus());
        verify(merchantRepository, times(1)).save(any(Merchant.class));
    }

    @Test
    void registerMerchant_UnauthorizedWhenOwnerIdNull() {
        RegisterMerchantRequest request = new RegisterMerchantRequest();
        request.setBusinessName("Test Store");

        assertThrows(UnauthorizedException.class, () -> merchantService.registerMerchant(request, null));
    }

    @Test
    void registerMerchant_DuplicateOwnerId() {
        RegisterMerchantRequest request = new RegisterMerchantRequest();
        request.setBusinessName("Test Store");

        when(merchantRepository.findByOwnerId("user-owner-1"))
                .thenReturn(Optional.of(Merchant.builder().id("m-1").build()));

        assertThrows(DuplicateResourceException.class, () -> merchantService.registerMerchant(request, "user-owner-1"));
    }

    @Test
    void checkMerchantActive_ReturnsActiveState() {
        Merchant activeMerchant = Merchant.builder()
                .id("m-100")
                .ownerId("user-1")
                .businessName("Store ABC")
                .status(MerchantStatus.APPROVED)
                .build();

        when(merchantRepository.findById("m-100")).thenReturn(Optional.of(activeMerchant));

        MerchantActiveResponse response = merchantService.checkMerchantActive("m-100");

        assertNotNull(response);
        assertTrue(response.isActive());
        assertEquals(MerchantStatus.APPROVED, response.getStatus());
    }

    @Test
    void getMerchantById_NotFound() {
        when(merchantRepository.findById("invalid-id")).thenReturn(Optional.empty());

        assertThrows(ResourceNotFoundException.class, () -> merchantService.getMerchantById("invalid-id"));
    }
}
